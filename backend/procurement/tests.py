from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .blockchain import hash_file, hash_payload, record_anchor, verify_anchor
from .models import Award, Bid, BlockchainAnchor, Project, Supplier

User = get_user_model()


def dummy_pdf(name="doc.pdf"):
    return SimpleUploadedFile(name, b"%PDF-1.4 fake", content_type="application/pdf")


def make_admin():
    return User.objects.create_user(
        username="admin", email="admin@example.com", password="pw", role=User.Role.ADMIN
    )


def make_head():
    return User.objects.create_user(
        username="head", email="head@example.com", password="pw", role=User.Role.HEAD
    )


def make_supplier(*, verified=True, categories=None):
    username = f"supplier{Supplier.objects.count()}"
    user = User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        password="pw",
        role=User.Role.SUPPLIER,
    )
    supplier = Supplier.objects.create(
        user=user,
        company="Acme Trading Corp.",
        contact="Jane Dela Cruz",
        business_types=categories or ["IT Equipment"],
        qualification_status=(
            Supplier.Qualification.VERIFIED if verified else Supplier.Qualification.PENDING
        ),
    )
    return supplier


def make_project(*, status=Project.Status.PUBLISHED, category="IT Equipment"):
    return Project.objects.create(
        code=f"P-2026-{Project.objects.count() + 1:03d}",
        name="Laptops for the registrar's office",
        category=category,
        status=status,
        budget=50000,
    )


class SupplierReviewTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.supplier = make_supplier(verified=False)

    def test_non_admin_cannot_approve_supplier(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_approve_verifies_supplier_and_emails_them(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.supplier.user.email])

    def test_admin_reject_sets_status_and_emails_reason(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/reject/", {"note": "Missing TIN"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.REJECTED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Missing TIN", mail.outbox[0].body)

    def test_admin_request_revision_requires_at_least_one_flagged_document(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/suppliers/{self.supplier.pk}/request-revision/", {"documents": {}}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


class SupplierSelfEditBusinessTypesTests(APITestCase):
    """A supplier may change their own business_types from Settings — no
    admin re-approval, applies immediately (per user decision, see memory)."""

    def setUp(self):
        cache.clear()
        self.supplier = make_supplier(verified=True, categories=["IT Equipment"])

    def test_supplier_can_update_own_business_types(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch(
            "/api/suppliers/me/", {"business_types": ["IT Equipment", "Furniture"]}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment", "Furniture"])
        # No re-approval triggered — verification status is untouched.
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)

    def test_business_types_cannot_be_emptied(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"business_types": []}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unknown_business_type_rejected(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"business_types": ["Not A Real Category"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_new_business_type_immediately_unlocks_matching_projects(self):
        # Supplier starts with only "IT Equipment" — a Furniture project isn't visible yet.
        make_project(status=Project.Status.PUBLISHED, category="Furniture")
        self.client.force_authenticate(user=self.supplier.user)
        before = self.client.get("/api/projects/")
        self.assertEqual(len(before.json()), 0)

        self.client.patch("/api/suppliers/me/", {"business_types": ["IT Equipment", "Furniture"]}, format="json")
        after = self.client.get("/api/projects/")
        self.assertEqual(len(after.json()), 1)
        self.assertEqual(after.json()[0]["category"], "Furniture")


class ProjectDocumentRevisionTests(APITestCase):
    """Head can flag a specific procurement document instead of an outright
    reject; the project bounces to Admin's Planning queue, then back to the
    Head's Pending Approval queue once the Admin fixes it."""

    def setUp(self):
        cache.clear()
        self.head = make_head()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PENDING_HEAD)
        self.project.purchase_request = dummy_pdf()
        self.project.save()

    def test_head_can_request_revision_on_one_document(self):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/request-revision/",
            {"documents": {"purchase_request": "wrong file, please reupload"}},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.NEEDS_REVISION)
        self.assertEqual(
            self.project.document_reviews["purchase_request"]["status"], "needs_revision"
        )

    def test_admin_cannot_request_revision(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/request-revision/",
            {"documents": {"purchase_request": "x"}}, format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_resubmit_returns_project_to_pending_head(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(
            f"/api/projects/{self.project.pk}/request-revision/",
            {"documents": {"purchase_request": "wrong file"}}, format="json",
        )

        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/resubmit-documents/",
            {"purchase_request": dummy_pdf("fixed.pdf")}, format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.PENDING_HEAD)
        self.assertEqual(
            self.project.document_reviews["purchase_request"]["status"], "resubmitted"
        )

    def test_cannot_resubmit_when_not_flagged(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/resubmit-documents/",
            {"purchase_request": dummy_pdf("fixed.pdf")}, format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


class BidEvaluationTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.winner_supplier = make_supplier()
        self.other_supplier = make_supplier()
        self.project = make_project()
        self.winning_bid = Bid.objects.create(
            project=self.project, supplier=self.winner_supplier, amount=45000,
        )
        self.other_bid = Bid.objects.create(
            project=self.project, supplier=self.other_supplier, amount=48000,
        )

    def test_non_admin_cannot_qualify_a_bid(self):
        self.client.force_authenticate(user=self.winner_supplier.user)
        res = self.client.post(f"/api/bids/{self.winning_bid.pk}/qualify/")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_qualify_sets_status_and_emails_supplier(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.winning_bid.pk}/qualify/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.winning_bid.refresh_from_db()
        self.assertEqual(self.winning_bid.status, Bid.Status.QUALIFIED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.winner_supplier.user.email])

    def test_admin_disqualify_sets_status_and_emails_supplier(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.other_bid.pk}/disqualify/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.other_bid.refresh_from_db()
        self.assertEqual(self.other_bid.status, Bid.Status.DISQUALIFIED)
        self.assertEqual(len(mail.outbox), 1)

    def test_select_winner_creates_award_and_emails_every_bidder(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.winning_bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.winning_bid.refresh_from_db()
        self.project.refresh_from_db()
        self.assertEqual(self.winning_bid.status, Bid.Status.WINNER)
        self.assertEqual(self.project.status, Project.Status.AWARDED)
        self.assertTrue(Award.objects.filter(project=self.project, supplier=self.winner_supplier).exists())

        # Winner + the other bidder both get an emailed result.
        self.assertEqual(len(mail.outbox), 2)
        recipients = {m.to[0] for m in mail.outbox}
        self.assertEqual(recipients, {self.winner_supplier.user.email, self.other_supplier.user.email})

    def test_select_winner_computes_expected_delivery_from_award_not_publish(self):
        # Standard procurement practice counts delivery from Notice to Proceed
        # (i.e. from award), not from when bidding closed — so this must be
        # computed at select-winner time, using whatever delivery_period_days
        # was configured, regardless of how long evaluation took.
        self.project.delivery_period_days = 30
        self.project.save(update_fields=["delivery_period_days"])
        self.assertIsNone(self.project.expected_delivery_date)

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{self.winning_bid.pk}/select-winner/")

        self.project.refresh_from_db()
        expected = timezone.localdate() + timedelta(days=30)
        self.assertEqual(self.project.expected_delivery_date, expected)


class BidSubmissionEligibilityTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.project = make_project()

    def _bid_payload(self):
        return {
            "amount": "10000",
            "delivery_timeline": "2 weeks",
            "notes": "We can deliver within the requested timeline and specifications.",
            "terms_accepted": "true",
            "interest_declared": "true",
            "scm_declared": "true",
            "accuracy_confirmed": "true",
            "quotation_document": dummy_pdf("quotation.pdf"),
        }

    def test_unverified_supplier_cannot_bid(self):
        supplier = make_supplier(verified=False)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_verified_supplier_can_bid_on_published_project(self):
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Bid.objects.filter(project=self.project, supplier=supplier).exists())

    def test_cannot_bid_on_a_project_not_open_for_bidding(self):
        draft_project = make_project(status=Project.Status.DRAFT)
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{draft_project.pk}/bid/", self._bid_payload(), format="multipart"
        )
        # A non-published project is excluded from get_queryset entirely for a
        # supplier, so get_object() 404s before the status check even runs.
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)


class BlockchainAnchorTests(APITestCase):
    """The anchoring layer: hashes are deterministic, every transition records
    one anchor, and a status change never depends on the chain succeeding."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.project = make_project(status=Project.Status.PENDING_HEAD)

    def test_hash_payload_is_deterministic_and_key_order_independent(self):
        first = hash_payload({"b": 2, "a": 1})
        second = hash_payload({"a": 1, "b": 2})
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("0x"))
        self.assertEqual(len(first), 66)  # the contract rejects anything else

    def test_hash_payload_changes_when_a_single_field_changes(self):
        base = {"code": "P-2026-001", "budget": "50000.00"}
        tampered = {"code": "P-2026-001", "budget": "50001.00"}
        self.assertNotEqual(hash_payload(base), hash_payload(tampered))

    def test_hash_file_hashes_contents_and_is_empty_without_a_file(self):
        self.assertEqual(hash_file(None), "")
        project = make_project()
        project.purchase_request = dummy_pdf("pr.pdf")
        project.save()
        digest = hash_file(project.purchase_request)
        self.assertEqual(len(digest), 66)
        self.assertEqual(digest, hash_file(project.purchase_request))  # stable

    def test_head_approve_records_an_anchor_and_returns_the_hash(self):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        anchor = BlockchainAnchor.objects.get(
            entity_ref=self.project.code, stage=BlockchainAnchor.Stage.HEAD_APPROVED
        )
        # The endpoint hands the browser everything it needs to sign.
        self.assertEqual(res.data["anchor"]["data_hash"], anchor.data_hash)
        self.assertEqual(res.data["anchor"]["id"], anchor.id)
        # Created un-anchored: the chain write happens afterwards, off-request.
        self.assertEqual(anchor.tx_hash, "")
        self.assertFalse(anchor.anchored)

    def test_each_lifecycle_transition_records_exactly_one_anchor(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/projects/{self.project.pk}/publish/")

        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/",
            {
                "amount": "10000",
                "delivery_timeline": "2 weeks",
                "notes": "We can deliver within the requested timeline and specifications.",
                "terms_accepted": "true", "interest_declared": "true",
                "scm_declared": "true", "accuracy_confirmed": "true",
                "quotation_document": dummy_pdf("quotation.pdf"),
            },
            format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        bid = Bid.objects.get(project=self.project, supplier=supplier)

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{bid.pk}/qualify/")
        res = self.client.post(f"/api/bids/{bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        stages = list(
            BlockchainAnchor.objects.filter(entity_ref=self.project.code)
            .values_list("stage", flat=True)
        )
        self.assertEqual(stages, [
            BlockchainAnchor.Stage.HEAD_APPROVED,
            BlockchainAnchor.Stage.BIDDING_OPEN,
            BlockchainAnchor.Stage.BID_SUBMITTED,
            BlockchainAnchor.Stage.BID_QUALIFIED,
            BlockchainAnchor.Stage.AWARDED,
        ])
        # The quotation document is bound into the bid's anchor hash, so
        # swapping the file afterwards would break verification.
        submitted = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.BID_SUBMITTED)
        self.assertTrue(submitted.document_hash.startswith("0x"))

    def test_anchor_endpoint_records_the_transaction(self):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        anchor_id = res.data["anchor"]["id"]
        tx = "0x" + "ab" * 32

        res = self.client.post(
            f"/api/projects/{self.project.pk}/anchor/",
            {"anchor_id": anchor_id, "tx_hash": tx, "block_number": 7654321},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        anchor = BlockchainAnchor.objects.get(pk=anchor_id)
        self.assertEqual(anchor.tx_hash, tx)
        self.assertEqual(anchor.block_number, 7654321)
        self.assertTrue(res.data["explorer_url"].endswith(tx))

    def test_anchor_endpoint_rejects_a_malformed_transaction_hash(self):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        res = self.client.post(
            f"/api/projects/{self.project.pk}/anchor/",
            {"anchor_id": res.data["anchor"]["id"], "tx_hash": "not-a-hash"},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_anchor_endpoint_is_idempotent(self):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        anchor_id = res.data["anchor"]["id"]
        first_tx = "0x" + "11" * 32
        body = {"anchor_id": anchor_id, "tx_hash": first_tx}
        self.client.post(f"/api/projects/{self.project.pk}/anchor/", body, format="json")
        # A retry (double click, flaky response) must never rewrite the trail.
        self.client.post(
            f"/api/projects/{self.project.pk}/anchor/",
            {"anchor_id": anchor_id, "tx_hash": "0x" + "22" * 32}, format="json",
        )
        self.assertEqual(BlockchainAnchor.objects.get(pk=anchor_id).tx_hash, first_tx)

    def test_supplier_cannot_anchor_a_project_transition(self):
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/anchor/",
            {"stage": "HEAD_APPROVED", "tx_hash": "0x" + "cd" * 32},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_record_anchor_never_raises_into_the_caller(self):
        # Anchoring is a side effect: if it fails, the approval it accompanies
        # must still stand — same contract as accounts.audit.log_action.
        with patch(
            "procurement.blockchain.BlockchainAnchor.objects.create",
            side_effect=RuntimeError("db down"),
        ):
            self.assertIsNone(record_anchor("PROJECT", "P-2026-001", "SUBMITTED", {"a": 1}))

    def test_status_change_survives_an_anchor_that_returns_nothing(self):
        # With anchoring unavailable the transition still succeeds and simply
        # reports no anchor, which the UI renders as "not yet anchored".
        self.client.force_authenticate(user=self.head)
        with patch("procurement.views.anchor_project", return_value=None):
            res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIsNone(res.data["anchor"])
        self.project.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.APPROVED)

    def test_public_anchor_trail_is_open_and_hash_only(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")

        self.client.force_authenticate(user=None)  # a member of the public
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["code"], self.project.code)
        self.assertEqual(len(res.data["anchors"]), 1)
        # Hashes only — never the payload, bid amounts, or supplier identities.
        self.assertNotIn("payload", res.data["anchors"][0])

    def test_award_document_upload_anchors_with_its_issue_date(self):
        # The NOA/NTP/Resolution are the instruments a later dispute turns on,
        # so each upload is anchored with BOTH the file hash and the issue date.
        project = make_project(status=Project.Status.AWARDED)
        supplier = make_supplier(verified=True)
        award = Award.objects.create(project=project, supplier=supplier, amount=1000)

        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/awards/{award.pk}/documents/",
            {"key": "notice_to_proceed", "file": dummy_pdf("ntp.pdf")},
            format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        award.refresh_from_db()
        self.assertTrue(award.notice_to_proceed)
        self.assertIsNotNone(award.ntp_issued_at)

        anchor = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.NTP_ISSUED)
        self.assertEqual(anchor.entity_ref, project.code)
        self.assertTrue(anchor.document_hash.startswith("0x"))
        # The issue date is inside the hashed payload — that's what makes a
        # backdated notice detectable.
        self.assertTrue(anchor.payload["issued_at"])
        self.assertEqual(res.data["anchor"]["stage"], "NTP_ISSUED")

    def test_replacing_an_award_document_appends_a_new_anchor(self):
        # A replacement must never overwrite the original entry — the trail has
        # to show that a document was swapped.
        project = make_project(status=Project.Status.AWARDED)
        award = Award.objects.create(
            project=project, supplier=make_supplier(verified=True), amount=1000)

        self.client.force_authenticate(user=self.admin)
        for name in ("noa-v1.pdf", "noa-v2.pdf"):
            self.client.post(
                f"/api/awards/{award.pk}/documents/",
                {"key": "notice_of_award", "file": dummy_pdf(name)},
                format="multipart",
            )
        anchors = BlockchainAnchor.objects.filter(stage=BlockchainAnchor.Stage.NOA_ISSUED)
        self.assertEqual(anchors.count(), 2)
        self.assertNotEqual(anchors[0].data_hash, anchors[1].data_hash)

    def test_award_document_upload_rejects_an_unknown_key(self):
        project = make_project(status=Project.Status.AWARDED)
        award = Award.objects.create(
            project=project, supplier=make_supplier(verified=True), amount=1000)
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/awards/{award.pk}/documents/",
            {"key": "contract", "file": dummy_pdf()},
            format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_generated_document_is_stored_once_and_anchored(self):
        # Generating fills the notice in from the award record, stores the PDF,
        # and anchors the hash of the STORED file.
        project = make_project(status=Project.Status.AWARDED)
        supplier = make_supplier(verified=True)
        award = Award.objects.create(project=project, supplier=supplier, amount=100000)

        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/awards/{award.pk}/documents/generate/",
            {"key": "notice_of_award"}, format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        award.refresh_from_db()
        self.assertTrue(award.notice_of_award.name.endswith(".pdf"))
        self.assertIsNotNone(award.noa_issued_at)

        anchor = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.NOA_ISSUED)
        # The anchored hash must be the hash of the file actually on disk —
        # that's the only way a downloader can ever reproduce it.
        self.assertEqual(anchor.document_hash, hash_file(award.notice_of_award))

    def test_stored_document_hash_is_stable_across_reads(self):
        # The whole verification story depends on this: the file is generated
        # ONCE, so hashing it again later gives the same digest. (Regenerating
        # per download would embed a new PDF timestamp and break verification.)
        project = make_project(status=Project.Status.AWARDED)
        award = Award.objects.create(
            project=project, supplier=make_supplier(verified=True), amount=100000)

        self.client.force_authenticate(user=self.admin)
        self.client.post(
            f"/api/awards/{award.pk}/documents/generate/",
            {"key": "notice_to_proceed"}, format="json",
        )
        award.refresh_from_db()
        self.assertEqual(hash_file(award.notice_to_proceed), hash_file(award.notice_to_proceed))

    def test_generated_documents_carry_the_award_details(self):
        from .documents import build_bac_resolution, build_notice_of_award

        project = make_project(status=Project.Status.AWARDED)
        award = Award.objects.create(
            project=project, supplier=make_supplier(verified=True), amount=100000)
        for build in (build_notice_of_award, build_bac_resolution):
            pdf = build(award)
            self.assertTrue(pdf.startswith(b"%PDF"))
            self.assertGreater(len(pdf), 800)

    def test_generate_rejects_an_unknown_document_key(self):
        award = Award.objects.create(
            project=make_project(status=Project.Status.AWARDED),
            supplier=make_supplier(verified=True), amount=1000)
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/awards/{award.pk}/documents/generate/", {"key": "contract"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_supplier_cannot_generate_award_documents(self):
        supplier = make_supplier(verified=True)
        award = Award.objects.create(
            project=make_project(status=Project.Status.AWARDED), supplier=supplier, amount=1000)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/awards/{award.pk}/documents/generate/",
            {"key": "notice_of_award"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_winner_can_read_their_own_award_documents(self):
        # The Notice of Award is addressed to the supplier — receiving it starts
        # the clock for posting their performance security — so the winner must
        # be able to collect it.
        project = make_project(status=Project.Status.AWARDED)
        supplier = make_supplier(verified=True)
        award = Award.objects.create(project=project, supplier=supplier, amount=1000)

        self.client.force_authenticate(user=self.admin)
        self.client.post(
            f"/api/awards/{award.pk}/documents/",
            {"key": "notice_of_award", "file": dummy_pdf("noa.pdf")},
            format="multipart",
        )

        self.client.force_authenticate(user=supplier.user)
        res = self.client.get("/api/awards/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(len(res.data), 1)
        noa = next(d for d in res.data[0]["documents"] if d["key"] == "notice_of_award")
        self.assertTrue(noa["url"])
        self.assertTrue(noa["issued_at"])

    def test_supplier_cannot_see_another_suppliers_award(self):
        winner = make_supplier(verified=True)
        rival = make_supplier(verified=True)
        Award.objects.create(
            project=make_project(status=Project.Status.AWARDED), supplier=winner, amount=1000)

        self.client.force_authenticate(user=rival.user)
        res = self.client.get("/api/awards/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data, [])

    def test_supplier_cannot_modify_an_award(self):
        supplier = make_supplier(verified=True)
        award = Award.objects.create(
            project=make_project(status=Project.Status.AWARDED), supplier=supplier, amount=1000)
        self.client.force_authenticate(user=supplier.user)
        # Read is allowed, writing is not — the supplier receives documents,
        # never issues or alters them.
        self.assertEqual(
            self.client.patch(f"/api/awards/{award.pk}/", {"amount": "999999"}, format="json").status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.delete(f"/api/awards/{award.pk}/").status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_only_admin_can_issue_award_documents(self):
        project = make_project(status=Project.Status.AWARDED)
        supplier = make_supplier(verified=True)
        award = Award.objects.create(project=project, supplier=supplier, amount=1000)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/awards/{award.pk}/documents/",
            {"key": "notice_of_award", "file": dummy_pdf()},
            format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_integrity_check_passes_for_an_untouched_record(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        anchor = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.HEAD_APPROVED)

        result = verify_anchor(anchor)
        self.assertEqual(result["status"], "match")
        self.assertEqual(result["record"], "match")

    def test_integrity_check_detects_an_edited_record(self):
        # THE point of the whole feature: comparing the stored hash with the
        # chain only proves the anchor row is intact. This proves the record
        # behind it is — an amount changed straight in the database no longer
        # hashes to what was published, and can't be hidden.
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        anchor = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.HEAD_APPROVED)
        self.assertEqual(verify_anchor(anchor)["status"], "match")

        Project.objects.filter(pk=self.project.pk).update(budget=999999)

        result = verify_anchor(anchor)
        self.assertEqual(result["status"], "mismatch")
        self.assertEqual(result["record"], "mismatch")
        self.assertIn("altered", result["detail"].lower())

    def test_deep_check_detects_a_swapped_document(self):
        # A record can be left untouched while the DOCUMENT it points at is
        # quietly replaced — caught only by re-hashing the file itself.
        project = make_project(status=Project.Status.PENDING_HEAD)
        project.approved_budget_document = dummy_pdf("budget.pdf")
        project.save()

        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{project.pk}/approve/")
        anchor = BlockchainAnchor.objects.get(
            entity_ref=project.code, stage=BlockchainAnchor.Stage.HEAD_APPROVED)
        self.assertEqual(verify_anchor(anchor, deep=True)["status"], "match")

        project.refresh_from_db()
        project.approved_budget_document = SimpleUploadedFile(
            "budget.pdf", b"%PDF-1.4 TAMPERED", content_type="application/pdf")
        project.save()

        result = verify_anchor(anchor, deep=True)
        self.assertEqual(result["document"], "mismatch")
        self.assertEqual(result["status"], "mismatch")
        # The cheap record-only check can't see a file swap — that's exactly why
        # the deep check exists.
        self.assertEqual(verify_anchor(anchor, deep=False)["record"], "match")

    def test_integrity_check_reports_a_deleted_record_honestly(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        anchor = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.HEAD_APPROVED)
        Project.objects.filter(pk=self.project.pk).delete()

        result = verify_anchor(anchor)
        # "unavailable", never a false accusation of tampering.
        self.assertEqual(result["status"], "unavailable")
        self.assertNotEqual(result["status"], "mismatch")

    def test_public_trail_reports_tampering_to_anyone(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        Project.objects.filter(pk=self.project.pk).update(budget=999999)

        self.client.force_authenticate(user=None)   # a member of the public
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["altered_count"], 1)
        self.assertEqual(res.data["anchors"][0]["integrity"]["status"], "mismatch")

    def test_public_trail_skips_document_hashing_unless_asked(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.client.force_authenticate(user=None)

        shallow = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        self.assertFalse(shallow.data["deep_checked"])
        self.assertEqual(shallow.data["anchors"][0]["integrity"]["document"], "skipped")

        deep = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/?deep=1")
        self.assertTrue(deep.data["deep_checked"])

    def test_public_anchor_trail_404s_on_an_unknown_code(self):
        res = self.client.get("/api/public/procurement/P-9999-999/anchors/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_public_trail_withholds_bid_document_hashes(self):
        # A losing bidder's quotation is not a public document, so its hash must
        # not be published — only the record hash that proves the step happened.
        project = make_project(status=Project.Status.PUBLISHED)
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        self.client.post(
            f"/api/projects/{project.pk}/bid/",
            {
                "amount": "10000", "delivery_timeline": "2 weeks",
                "notes": "We can deliver within the requested timeline and specifications.",
                "terms_accepted": "true", "interest_declared": "true",
                "scm_declared": "true", "accuracy_confirmed": "true",
                "quotation_document": dummy_pdf("quotation.pdf"),
            },
            format="multipart",
        )
        stored = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.BID_SUBMITTED)
        self.assertTrue(stored.document_hash)  # kept internally

        self.client.force_authenticate(user=None)
        res = self.client.get(f"/api/public/procurement/{project.code}/anchors/")
        published = next(a for a in res.data["anchors"] if a["entity_type"] == "BID")
        self.assertEqual(published["document_hash"], "")
        self.assertTrue(published["data_hash"].startswith("0x"))

    def test_supplier_does_not_see_rivals_bid_anchors_on_a_project(self):
        project = make_project(status=Project.Status.PUBLISHED)
        rival = make_supplier(verified=True)
        self.client.force_authenticate(user=rival.user)
        self.client.post(
            f"/api/projects/{project.pk}/bid/",
            {
                "amount": "10000", "delivery_timeline": "2 weeks",
                "notes": "We can deliver within the requested timeline and specifications.",
                "terms_accepted": "true", "interest_declared": "true",
                "scm_declared": "true", "accuracy_confirmed": "true",
                "quotation_document": dummy_pdf("quotation.pdf"),
            },
            format="multipart",
        )

        other = make_supplier(verified=True)
        self.client.force_authenticate(user=other.user)
        res = self.client.get("/api/projects/")
        row = next(p for p in res.data if p["code"] == project.code)
        self.assertEqual([a for a in row["anchors"] if a["entity_type"] == "BID"], [])

        # The Admin, who runs the evaluation, still sees the whole trail.
        self.client.force_authenticate(user=self.admin)
        res = self.client.get("/api/projects/")
        row = next(p for p in res.data if p["code"] == project.code)
        self.assertTrue(any(a["entity_type"] == "BID" for a in row["anchors"]))
