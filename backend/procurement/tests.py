from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .blockchain import (
    hash_file, hash_payload, record_anchor, submit_anchor_server_side, verify_anchor,
)
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
        # No BID_QUALIFIED: qualification happens for every bidder, and only the
        # winner's bid is published. BID_SUBMITTED appears here even though the
        # bid was submitted much earlier — it is written at award time, right
        # before AWARDED, so the trail still reads offer-then-award.
        self.assertEqual(stages, [
            BlockchainAnchor.Stage.HEAD_APPROVED,
            BlockchainAnchor.Stage.BIDDING_OPEN,
            BlockchainAnchor.Stage.BID_SUBMITTED,
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

    def _bid(self, project, supplier, amount="10000"):
        self.client.force_authenticate(user=supplier.user)
        self.client.post(
            f"/api/projects/{project.pk}/bid/",
            {
                "amount": amount, "delivery_timeline": "2 weeks",
                "notes": "We can deliver within the requested timeline and specifications.",
                "terms_accepted": "true", "interest_declared": "true",
                "scm_declared": "true", "accuracy_confirmed": "true",
                "quotation_document": dummy_pdf("quotation.pdf"),
            },
            format="multipart",
        )
        return Bid.objects.get(project=project, supplier=supplier)

    def test_public_trail_withholds_bid_document_hashes(self):
        # The winning quotation's hash is kept internally but never published:
        # the public trail proves the step happened without exposing the file.
        project = make_project(status=Project.Status.PUBLISHED)
        supplier = make_supplier(verified=True)
        bid = self._bid(project, supplier)

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{bid.pk}/select-winner/")

        stored = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.BID_SUBMITTED)
        self.assertTrue(stored.document_hash)  # kept internally

        self.client.force_authenticate(user=None)
        res = self.client.get(f"/api/public/procurement/{project.code}/anchors/")
        published = next(a for a in res.data["anchors"] if a["entity_type"] == "BID")
        self.assertEqual(published["document_hash"], "")
        self.assertTrue(published["data_hash"].startswith("0x"))

    def test_only_the_winning_bid_is_ever_anchored(self):
        # The point of the whole scoping rule: a supplier who bids and loses
        # leaves nothing on the public ledger. Their amount is commercial
        # information and never becomes anyone else's business.
        project = make_project(status=Project.Status.PUBLISHED)
        winner = make_supplier(verified=True)
        loser = make_supplier(verified=True)
        winning_bid = self._bid(project, winner, "10000")
        losing_bid = self._bid(project, loser, "12000")

        # Nothing is anchored while bidding and evaluation are still running.
        self.assertFalse(
            BlockchainAnchor.objects.filter(
                entity_type=BlockchainAnchor.EntityType.BID).exists()
        )
        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{winning_bid.pk}/qualify/")
        self.client.post(f"/api/bids/{losing_bid.pk}/disqualify/")
        self.assertFalse(
            BlockchainAnchor.objects.filter(
                entity_type=BlockchainAnchor.EntityType.BID).exists()
        )

        self.client.post(f"/api/bids/{winning_bid.pk}/select-winner/")

        bid_anchors = BlockchainAnchor.objects.filter(
            entity_type=BlockchainAnchor.EntityType.BID)
        self.assertEqual(bid_anchors.count(), 1)
        self.assertEqual(int(bid_anchors.first().entity_id), winning_bid.id)

    def test_supplier_does_not_see_rivals_bid_anchors_on_a_project(self):
        project = make_project(status=Project.Status.PUBLISHED)
        rival = make_supplier(verified=True)
        bid = self._bid(project, rival)

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{bid.pk}/select-winner/")

        # The winning bid's anchor now exists, so this is the moment a rival
        # could in principle read it. They can't: awarding drops the project out
        # of the supplier feed entirely, so there is no row to read it from.
        other = make_supplier(verified=True)
        self.client.force_authenticate(user=other.user)
        res = self.client.get("/api/projects/")
        self.assertEqual([p for p in res.data if p["code"] == project.code], [])

        # The Admin, who runs the evaluation, still sees the whole trail.
        self.client.force_authenticate(user=self.admin)
        res = self.client.get("/api/projects/")
        row = next(p for p in res.data if p["code"] == project.code)
        self.assertTrue(any(a["entity_type"] == "BID" for a in row["anchors"]))


class ServerSideSigningTests(APITestCase):
    """The no-MetaMask path: the backend signs and submits anchors itself.

    web3 talks to a live network, so it is mocked. What these tests pin down are
    the three things that are easy to get wrong here and effectively invisible
    until they fail in production against real money-shaped constraints: where
    the nonce comes from, that the request never blocks on mining, and that a
    failure stays best-effort instead of breaking the transition it accompanies.
    """

    TX_HASH = "0x" + "ab" * 32

    def _anchor(self):
        return BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT,
            entity_ref="P-2026-001",
            stage=BlockchainAnchor.Stage.HEAD_APPROVED,
            data_hash="0x" + "cd" * 32,
        )

    def _fake_web3(self, send_raises=None):
        """A stand-in Web3 class that records the tx params it is handed."""
        captured = {}
        Web3 = MagicMock(name="Web3")
        Web3.to_checksum_address.side_effect = lambda a: a
        # Real HexBytes.hex() lost its "0x" prefix in hexbytes>=1.0; to_hex keeps it.
        Web3.to_hex.side_effect = lambda _: self.TX_HASH

        w3 = Web3.return_value
        w3.eth.account.from_key.return_value.address = "0x" + "11" * 20
        w3.eth.get_transaction_count.return_value = 7
        w3.eth.gas_price = 10
        w3.to_wei.return_value = 1
        if send_raises:
            w3.eth.send_raw_transaction.side_effect = send_raises
        else:
            w3.eth.send_raw_transaction.return_value = b"\xab" * 32

        ledger = w3.eth.contract.return_value
        ledger.functions.recordEvent.return_value.build_transaction.side_effect = (
            lambda params: captured.update(params) or dict(params)
        )
        return Web3, w3, captured

    def _submit(self, Web3, enabled=True):
        anchor = self._anchor()
        with patch("procurement.blockchain._load_web3", return_value=Web3), \
             patch("procurement.blockchain.SERVER_SIGNING_ENABLED", enabled), \
             patch("procurement.blockchain.BLOCKCHAIN_PRIVATE_KEY", "0x" + "22" * 32), \
             patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", "0x" + "33" * 20):
            result = submit_anchor_server_side(anchor)
        anchor.refresh_from_db()
        return result, anchor

    def test_nonce_is_read_from_pending_not_latest(self):
        # Awarding issues three documents back to back. Off the default "latest"
        # block the earlier transactions are still unmined, so all three would
        # claim one nonce and two would be rejected.
        Web3, w3, _ = self._fake_web3()
        self._submit(Web3)
        w3.eth.get_transaction_count.assert_called_once_with("0x" + "11" * 20, "pending")

    def test_does_not_block_the_request_waiting_to_be_mined(self):
        # A Sepolia block takes ~12-30s, past gunicorn's 30s worker timeout —
        # waiting here would turn a successful approval into a 502.
        Web3, w3, _ = self._fake_web3()
        _, anchor = self._submit(Web3)
        w3.eth.wait_for_transaction_receipt.assert_not_called()
        self.assertEqual(anchor.tx_hash, self.TX_HASH)
        # No receipt means no block number, by design.
        self.assertIsNone(anchor.block_number)

    def test_transaction_hash_is_stored_0x_prefixed(self):
        # attach_transaction rejects an unprefixed hash outright, and the failure
        # would be swallowed as "anchoring didn't work" with no clue why.
        Web3, _, _ = self._fake_web3()
        _, anchor = self._submit(Web3)
        self.assertTrue(anchor.tx_hash.startswith("0x"))
        self.assertEqual(len(anchor.tx_hash), 66)
        self.assertTrue(anchor.anchored)

    def test_a_failed_submission_leaves_the_record_valid_and_retryable(self):
        # Same contract as a declined MetaMask prompt: no exception escapes, the
        # record stands, and the UI offers "Anchor now".
        Web3, _, _ = self._fake_web3(send_raises=RuntimeError("insufficient funds"))
        result, anchor = self._submit(Web3)
        self.assertIsNone(result)
        self.assertEqual(anchor.tx_hash, "")
        self.assertFalse(anchor.anchored)

    def test_nothing_is_submitted_while_server_signing_is_off(self):
        # The default. Enabling it is an explicit deployment decision, so the
        # code path must stay completely inert until then.
        Web3, w3, _ = self._fake_web3()
        result, anchor = self._submit(Web3, enabled=False)
        self.assertIsNone(result)
        self.assertFalse(anchor.anchored)
        w3.eth.send_raw_transaction.assert_not_called()

    def test_gas_and_chain_id_target_sepolia(self):
        Web3, _, captured = self._fake_web3()
        self._submit(Web3)
        self.assertEqual(captured["chainId"], 11155111)
        self.assertEqual(captured["from"], "0x" + "11" * 20)


class PayloadVersionTests(APITestCase):
    """The integrity check must not cry wolf, and must still catch real edits.

    v1 hashed fields that legitimately change as a procurement advances
    (status, deadline, reviewed_at, published_at), so re-hashing an early stage
    later produced a different value and honest records were reported as
    altered. v2 hashes only what is final at anchor time. These tests pin both
    halves: no false alarm on a normal lifecycle, and no weakening of the real
    tamper detection that justifies the feature existing.
    """

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.project = make_project(status=Project.Status.PENDING_HEAD)

    def _anchors(self):
        return BlockchainAnchor.objects.filter(entity_ref=self.project.code).order_by("id")

    def _advance_through_the_lifecycle(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/projects/{self.project.pk}/publish/")

    def test_advancing_a_procurement_does_not_report_earlier_steps_as_altered(self):
        # The regression this whole version bump exists for. Approving and then
        # publishing changes status, deadline, reviewed_at and published_at —
        # under v1 that turned every earlier anchor red on the public page.
        self._advance_through_the_lifecycle()
        anchors = list(self._anchors())
        self.assertGreaterEqual(len(anchors), 2)
        for anchor in anchors:
            self.assertEqual(
                verify_anchor(anchor)["status"], "match",
                f"{anchor.stage} reported as altered after a normal lifecycle step",
            )

    def test_an_edited_budget_is_still_caught(self):
        # The check that makes the feature worth having: if this ever passes
        # silently, the verifier is decoration.
        self._advance_through_the_lifecycle()
        anchor = self._anchors().first()
        self.assertEqual(verify_anchor(anchor)["status"], "match")

        self.project.budget = 999999
        self.project.save(update_fields=["budget"])
        result = verify_anchor(anchor)
        self.assertEqual(result["status"], "mismatch")
        self.assertIn("altered", result["detail"])

    def test_an_edited_name_is_still_caught(self):
        self._advance_through_the_lifecycle()
        anchor = self._anchors().first()
        self.project.name = "Something else entirely"
        self.project.save(update_fields=["name"])
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def _write_v1_anchor(self, stage=BlockchainAnchor.Stage.SUBMITTED):
        """An anchor exactly as v1 would have written it, including the fields
        v2 dropped — this is what is already sitting on Sepolia."""
        payload = {
            "v": 1,
            "entity": "PROJECT",
            "stage": str(stage),
            "code": self.project.code,
            "name": self.project.name,
            "category": self.project.category or "",
            "type": self.project.type or "",
            "budget": f"{self.project.budget:.2f}",
            "status": self.project.status,
            "bidding_period_days": self.project.bidding_period_days or 0,
            "delivery_period_days": self.project.delivery_period_days or 0,
            "deadline": "",
            "created_at": self.project.created_at.isoformat(),
            "reviewed_at": "",
            "published_at": "",
            "document_hash": "",
        }
        return BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT,
            entity_ref=self.project.code, entity_id=str(self.project.id),
            stage=stage, data_hash=hash_payload(payload), payload=payload,
            tx_hash="0x" + "ab" * 32,
        )

    def test_v1_anchors_still_verify_after_the_version_bump(self):
        # Anchors already on-chain cannot be rewritten, so the bump must not
        # invalidate them — otherwise fixing the false alarm would replace it
        # with a worse one.
        anchor = self._write_v1_anchor()
        self._advance_through_the_lifecycle()
        self.assertEqual(verify_anchor(anchor)["status"], "match")

    def test_v1_anchors_still_catch_a_tampered_record(self):
        # The compatibility path must not become a blanket "match".
        anchor = self._write_v1_anchor()
        self.project.budget = 1
        self.project.save(update_fields=["budget"])
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def test_a_rewritten_v1_snapshot_is_rejected(self):
        # Someone editing the stored payload to match a doctored record still
        # fails: the snapshot no longer hashes to what is published on-chain.
        anchor = self._write_v1_anchor()
        self.project.budget = 1
        self.project.save(update_fields=["budget"])
        anchor.payload = {**anchor.payload, "budget": "1.00"}
        anchor.save(update_fields=["payload"])
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")
