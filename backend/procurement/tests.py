import io
import json
import shutil
import tempfile
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.core import mail
from django.core.cache import cache
from django.core.management import call_command
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.files.storage import FileSystemStorage, default_storage
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from PIL import Image

from accounts.models import AuditLog

from .blockchain import (
    anchor_summary, bid_parts, confirm_anchor, hash_file, hash_payload, record_anchor,
    submit_anchor_server_side, verify_anchor,
)
from accounts.tests import registration_payload

from .document_requirements import CATEGORY_DOCUMENTS, requirements_for, validate_registry
from .models import (
    BID_DOCUMENT_KEYS, SUPPLIER_DOCUMENT_FIELDS, SUPPLIER_DOCUMENT_KEYS, Award, Bid, BidProductImage,
    BlockchainAnchor, Project, Supplier, SupplierCategoryDocument,
)

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
        # Approval now requires a confirmed email (see EmailVerificationGateTests)
        # and every required document (see SupplierApprovalDocumentTests).
        attach_base_documents(self.supplier)
        self.supplier.email_verified = True
        self.supplier.save(update_fields=["email_verified"])
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
    """A verified supplier REQUESTS category changes from Settings; they apply
    only once an Admin approves them. (Was: applied immediately, with no
    re-approval — reversed by decision 6 in the 2026-10 audit, because it let a
    supplier verified for one category bid in any other.)"""

    def setUp(self):
        cache.clear()
        self.supplier = make_supplier(verified=True, categories=["IT Equipment"])

    def test_supplier_change_is_filed_as_a_pending_request(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch(
            "/api/suppliers/me/", {"business_types": ["IT Equipment", "Furniture"]}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["category_request_status"], "pending")

        self.supplier.refresh_from_db()
        # The approved set is untouched until an Admin decides.
        self.assertEqual(self.supplier.business_types, ["IT Equipment"])
        self.assertEqual(self.supplier.pending_business_types, ["IT Equipment", "Furniture"])
        # Verification status is untouched — they keep bidding in IT Equipment.
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)

    def test_business_types_cannot_be_emptied(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"business_types": []}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unknown_business_type_rejected(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"business_types": ["Not A Real Category"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_new_business_type_unlocks_matching_projects_only_after_admin_approval(self):
        # Supplier starts with only "IT Equipment" — a Furniture project isn't visible yet.
        make_project(status=Project.Status.PUBLISHED, category="Furniture")
        self.client.force_authenticate(user=self.supplier.user)
        before = self.client.get("/api/projects/")
        self.assertEqual(len(before.json()), 0)

        self.client.patch("/api/suppliers/me/", {"business_types": ["IT Equipment", "Furniture"]}, format="json")
        pending = self.client.get("/api/projects/")
        self.assertEqual(len(pending.json()), 0)   # a pending request grants nothing

        self.client.force_authenticate(user=make_admin())
        self.client.post(f"/api/suppliers/{self.supplier.pk}/approve-categories/")
        self.client.force_authenticate(user=self.supplier.user)
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
        # Already QUALIFIED: only a bid that passed evaluation can be awarded
        # (BidViewSet.select_winner enforces it), so this fixture stands where a
        # real bid stands by the time a winner is picked.
        self.winning_bid = Bid.objects.create(
            project=self.project, supplier=self.winner_supplier, amount=45000,
            status=Bid.Status.QUALIFIED,
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
        # A bid must pass evaluation before it can be awarded.
        self.client.post(f"/api/bids/{bid.pk}/qualify/")
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
        # A bid must pass evaluation before it can be awarded.
        self.client.post(f"/api/bids/{bid.pk}/qualify/")
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
        w3.eth.max_priority_fee = 3
        w3.eth.get_block.return_value = {"baseFeePerGas": 10}
        if send_raises:
            w3.eth.send_raw_transaction.side_effect = send_raises
        else:
            w3.eth.send_raw_transaction.return_value = b"\xab" * 32

        ledger = w3.eth.contract.return_value
        ledger.functions.recordEvent.return_value.estimate_gas.return_value = 1_168_782
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

    def test_fee_cap_is_never_below_the_tip_when_gas_is_cheap(self):
        # Regression: a fixed 1.5 gwei tip against a `gas_price * 2` cap broke
        # whenever Sepolia gas fell under 0.75 gwei, and the node refused every
        # server-signed anchor ("max priority fee per gas higher than max fee").
        Web3, w3, captured = self._fake_web3()
        w3.eth.gas_price = 100_000_000                       # 0.1 gwei
        w3.eth.get_block.return_value = {"baseFeePerGas": 50_000_000}
        w3.eth.max_priority_fee = 1_500_000_000              # 1.5 gwei tip
        self._submit(Web3)
        self.assertGreaterEqual(captured["maxFeePerGas"], captured["maxPriorityFeePerGas"])
        self.assertEqual(captured["maxFeePerGas"], 2 * 50_000_000 + 1_500_000_000)

    def test_gas_limit_comes_from_the_estimate_with_headroom(self):
        # Regression: a fixed 400k limit was far below the ~1.17M gas recordEvent
        # really needs, so every server-signed anchor ran out of gas and reverted
        # on-chain while the app showed it as anchored.
        Web3, _, captured = self._fake_web3()
        self._submit(Web3)
        self.assertEqual(captured["gas"], int(1_168_782 * 1.25))

    def test_a_call_that_would_revert_is_never_sent(self):
        # estimate_gas raises when the contract would reject the call. Sending it
        # anyway would burn gas and mark the record anchored when it isn't.
        Web3, w3, _ = self._fake_web3()
        ledger = w3.eth.contract.return_value
        ledger.functions.recordEvent.return_value.estimate_gas.side_effect = RuntimeError("execution reverted")
        result, anchor = self._submit(Web3)
        self.assertIsNone(result)
        self.assertFalse(anchor.anchored)
        w3.eth.send_raw_transaction.assert_not_called()

    def test_gas_and_chain_id_target_sepolia(self):
        Web3, _, captured = self._fake_web3()
        self._submit(Web3)
        self.assertEqual(captured["chainId"], 11155111)
        self.assertEqual(captured["from"], "0x" + "11" * 20)


class NotFound(Exception):
    """Stands in for web3.exceptions.TransactionNotFound (matched by name)."""


NotFound.__name__ = "TransactionNotFound"


class AnchorConfirmationTests(APITestCase):
    """confirm_anchor / `confirm_anchors`: a record may only stay "On-chain" if
    the chain agrees. Server-signed transactions are recorded when SENT, so this
    is the step that catches one that later fails or is never mined."""

    TX = "0x" + "ab" * 32

    def _sent(self, minutes_ago=5):
        return BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.AWARD, entity_ref="P-2026-007",
            entity_id="31", stage=BlockchainAnchor.Stage.NOA_ISSUED, data_hash="0x" + "cd" * 32,
            tx_hash=self.TX, actor_address="0x" + "11" * 20,
            anchored_at=timezone.now() - timedelta(minutes=minutes_ago),
        )

    def _w3(self, receipt=None, receipt_missing=False, tx_known=True):
        w3 = MagicMock(name="w3")
        if receipt_missing:
            w3.eth.get_transaction_receipt.side_effect = NotFound()
        else:
            w3.eth.get_transaction_receipt.return_value = receipt
        if not tx_known:
            w3.eth.get_transaction.side_effect = NotFound()
        return w3

    def test_a_successful_transaction_gets_its_block_number(self):
        anchor = self._sent()
        outcome = confirm_anchor(anchor, w3=self._w3({"status": 1, "blockNumber": 11962500}))
        anchor.refresh_from_db()
        self.assertEqual(outcome, "confirmed")
        self.assertEqual(anchor.block_number, 11962500)
        self.assertEqual(anchor.tx_hash, self.TX)

    def test_a_reverted_transaction_is_cleared_and_audit_logged(self):
        # Regression: out-of-gas transactions reverted on-chain while the
        # Awards page kept showing them as anchored.
        anchor = self._sent()
        outcome = confirm_anchor(anchor, w3=self._w3({"status": 0, "blockNumber": 11962193}))
        anchor.refresh_from_db()
        self.assertEqual(outcome, "reverted")
        self.assertFalse(anchor.anchored)               # shows "Anchor now" again
        self.assertIsNone(anchor.block_number)
        self.assertEqual(anchor.actor_address, "")
        # The failed attempt is not erased from history.
        entry = AuditLog.objects.get(action="blockchain.reverted")
        self.assertIn(self.TX, entry.description)

    def test_a_transaction_still_in_the_mempool_is_left_alone(self):
        anchor = self._sent()
        outcome = confirm_anchor(anchor, w3=self._w3(receipt_missing=True, tx_known=True))
        anchor.refresh_from_db()
        self.assertEqual(outcome, "pending")
        self.assertEqual(anchor.tx_hash, self.TX)

    def test_an_unknown_transaction_is_only_dropped_after_the_grace_period(self):
        w3 = self._w3(receipt_missing=True, tx_known=False)
        self.assertEqual(confirm_anchor(self._sent(minutes_ago=5), w3=w3), "pending")

        stale = self._sent(minutes_ago=120)
        self.assertEqual(confirm_anchor(stale, w3=w3), "dropped")
        stale.refresh_from_db()
        self.assertFalse(stale.anchored)

    def test_a_node_error_changes_nothing(self):
        # An RPC outage is not evidence that the transaction failed.
        anchor = self._sent()
        w3 = MagicMock()
        w3.eth.get_transaction_receipt.side_effect = ConnectionError("node down")
        self.assertEqual(confirm_anchor(anchor, w3=w3), "unknown")
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, self.TX)

    def test_preview_mode_saves_nothing(self):
        anchor = self._sent()
        outcome = confirm_anchor(anchor, w3=self._w3({"status": 0, "blockNumber": 1}), apply=False)
        anchor.refresh_from_db()
        self.assertEqual(outcome, "reverted")
        self.assertEqual(anchor.tx_hash, self.TX)
        self.assertFalse(AuditLog.objects.filter(action="blockchain.reverted").exists())

    def test_the_command_only_changes_data_with_apply(self):
        anchor = self._sent()
        w3 = self._w3({"status": 0, "blockNumber": 1})
        with patch("procurement.blockchain.web3_client", return_value=w3):
            call_command("confirm_anchors", stdout=io.StringIO())
            anchor.refresh_from_db()
            self.assertEqual(anchor.tx_hash, self.TX)

            out = io.StringIO()
            call_command("confirm_anchors", "--apply", stdout=out)
        anchor.refresh_from_db()
        self.assertFalse(anchor.anchored)
        self.assertIn("1 reverted", out.getvalue())

    def test_the_command_skips_anchors_that_are_already_confirmed(self):
        BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT, entity_ref="P-2026-001",
            stage=BlockchainAnchor.Stage.HEAD_APPROVED, data_hash="0x" + "cd" * 32,
            tx_hash=self.TX, block_number=100,
        )
        w3 = MagicMock()
        with patch("procurement.blockchain.web3_client", return_value=w3):
            call_command("confirm_anchors", "--apply", stdout=io.StringIO())
        w3.eth.get_transaction_receipt.assert_not_called()

    def test_the_command_never_raises(self):
        # It runs inside the Render build; a failure here must not fail a deploy.
        self._sent()
        with patch("procurement.blockchain.web3_client", side_effect=RuntimeError("boom")):
            call_command("confirm_anchors", "--apply", stdout=io.StringIO(), stderr=io.StringIO())


class ServerSubmitRetryTests(APITestCase):
    """"Anchor now" with server signing on: the server signs the retry, so no
    one needs MetaMask. It reuses the record's own /anchor/ endpoint, so the
    same role checks apply as for a MetaMask attach."""

    TX = "0x" + "ef" * 32

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.project = make_project(status=Project.Status.PENDING_HEAD)
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.anchor_id = res.data["anchor"]["id"]
        self.url = f"/api/projects/{self.project.pk}/anchor/"
        self.body = {"anchor_id": self.anchor_id, "server_submit": True}

    def _fake_submit(self, anchor):
        anchor.tx_hash = self.TX
        anchor.actor_address = "0x" + "11" * 20
        anchor.anchored_at = timezone.now()
        anchor.save()
        return anchor

    def _signing(self, enabled=True, **submit):
        return (
            patch("procurement.blockchain.SERVER_SIGNING_ENABLED", enabled),
            patch("procurement.blockchain.submit_anchor_server_side", **submit),
        )

    def test_server_signs_the_retry(self):
        on, submit = self._signing(side_effect=self._fake_submit)
        with on, submit:
            res = self.client.post(self.url, self.body, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["tx_hash"], self.TX)
        self.assertTrue(BlockchainAnchor.objects.get(pk=self.anchor_id).anchored)
        self.assertTrue(AuditLog.objects.filter(
            action="blockchain.anchored", description__contains="server-signed").exists())

    def test_refused_when_server_signing_is_off(self):
        off, submit = self._signing(enabled=False)
        with off, submit as mocked:
            res = self.client.post(self.url, self.body, format="json")
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        mocked.assert_not_called()
        self.assertFalse(BlockchainAnchor.objects.get(pk=self.anchor_id).anchored)

    def test_a_failed_submission_leaves_the_record_retryable(self):
        on, submit = self._signing(return_value=None)
        with on, submit:
            res = self.client.post(self.url, self.body, format="json")
        self.assertEqual(res.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertFalse(BlockchainAnchor.objects.get(pk=self.anchor_id).anchored)

    def test_an_already_anchored_record_is_never_sent_twice(self):
        BlockchainAnchor.objects.filter(pk=self.anchor_id).update(tx_hash=self.TX)
        on, submit = self._signing()
        with on, submit as mocked:
            res = self.client.post(self.url, self.body, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        mocked.assert_not_called()

    def test_same_role_rules_as_a_metamask_attach(self):
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        on, submit = self._signing()
        with on, submit as mocked:
            res = self.client.post(self.url, self.body, format="json")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)
        mocked.assert_not_called()

    def test_anchor_summary_tells_the_browser_whether_the_server_signs(self):
        anchor = BlockchainAnchor.objects.get(pk=self.anchor_id)
        with patch("procurement.blockchain.SERVER_SIGNING_ENABLED", True):
            self.assertTrue(anchor_summary(anchor)["server_signing"])
        with patch("procurement.blockchain.SERVER_SIGNING_ENABLED", False):
            self.assertFalse(anchor_summary(anchor)["server_signing"])


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


# ── Bid product images ───────────────────────────────────────────────────────

def make_image(name="photo.png", fmt="PNG", size=(8, 8)):
    """A real, decodable image of the given format (Pillow-generated)."""
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, format=fmt)
    content_type = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}[fmt]
    return SimpleUploadedFile(name, buf.getvalue(), content_type=content_type)


class BidProductImageTests(APITestCase):
    """Suppliers attach up to 5 product photos to a bid. Validation is by real
    content, only the owner may change them and only while bidding is open, and
    none of it may touch the blockchain anchors."""

    def setUp(self):
        cache.clear()
        self._media = tempfile.mkdtemp()
        self._override = override_settings(MEDIA_ROOT=self._media)
        self._override.enable()
        self.admin = make_admin()
        self.supplier = make_supplier()
        self.other = make_supplier()
        self.project = make_project()
        self.bid = Bid.objects.create(project=self.project, supplier=self.supplier, amount=45000)

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self._media, ignore_errors=True)

    # helpers
    def _bid_payload(self, **extra):
        data = {
            "amount": "10000",
            "delivery_timeline": "2 weeks",
            "notes": "We can deliver within the requested timeline and specifications.",
            "terms_accepted": "true", "interest_declared": "true",
            "scm_declared": "true", "accuracy_confirmed": "true",
            "quotation_document": dummy_pdf("quotation.pdf"),
        }
        data.update(extra)
        return data

    def _upload(self, *files, captions=None, user=None, bid=None):
        self.client.force_authenticate(user=user or self.supplier.user)
        data = {"product_images": list(files)}
        if captions is not None:
            data["product_image_captions"] = captions
        return self.client.post(f"/api/bids/{(bid or self.bid).pk}/images/", data, format="multipart")

    def _add_images(self, n, bid=None):
        for i in range(n):
            img = BidProductImage(bid=bid or self.bid, caption=f"view {i}")
            img.image.save("image.png", make_image(), save=True)

    # 1. valid upload
    def test_supplier_can_upload_a_valid_image_with_caption(self):
        res = self._upload(make_image("my holiday photo!!.png"), captions=["Brand X Model Y, front view"])
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)

        image = BidProductImage.objects.get(bid=self.bid)
        self.assertEqual(image.caption, "Brand X Model Y, front view")
        # Stored under a random name — nothing of the uploaded filename survives.
        self.assertRegex(image.image.name, r"^bid_documents/product_images/\d+/[0-9a-f]{32}\.png$")
        self.assertEqual(len(res.data["product_images"]), 1)
        self.assertIn("/api/files/bidimage/", res.data["product_images"][0]["url"])
        self.assertTrue(AuditLog.objects.filter(action="bid.image_uploaded", entity_id=str(self.bid.id)).exists())

    def test_stored_extension_follows_real_format_not_the_filename(self):
        res = self._upload(make_image("looks-like.png", fmt="JPEG"))
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        self.assertTrue(BidProductImage.objects.get(bid=self.bid).image.name.endswith(".jpg"))

    def test_webp_is_accepted(self):
        res = self._upload(make_image("p.webp", fmt="WEBP"))
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)

    # 2. wrong type
    def test_rejects_non_image_disguised_as_png(self):
        fake = SimpleUploadedFile("photo.png", b"%PDF-1.4 not an image", content_type="image/png")
        res = self._upload(fake)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(BidProductImage.objects.exists())

    def test_rejects_real_image_of_a_disallowed_format(self):
        res = self._upload(make_image("anim.png", fmt="GIF"))
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(BidProductImage.objects.exists())

    # 3. oversized
    def test_rejects_file_over_5mb(self):
        valid = make_image().read()
        big = SimpleUploadedFile("big.png", valid + b"\0" * (5 * 1024 * 1024), content_type="image/png")
        res = self._upload(big)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("5MB", str(res.data))
        self.assertFalse(BidProductImage.objects.exists())

    # 4. too many
    def test_rejects_a_sixth_image(self):
        self._add_images(5)
        res = self._upload(make_image())
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(BidProductImage.objects.filter(bid=self.bid).count(), 5)

    def test_rejects_more_than_five_in_one_bid_submission(self):
        supplier = make_supplier()
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/",
            self._bid_payload(product_images=[make_image() for _ in range(6)]), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Bid.objects.filter(supplier=supplier).exists())

    # 5. after deadline
    def test_rejects_upload_after_deadline(self):
        self.project.deadline = timezone.localdate() - timedelta(days=1)
        self.project.save(update_fields=["deadline"])
        res = self._upload(make_image())
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(BidProductImage.objects.exists())

    def test_rejects_delete_after_bidding_closed(self):
        self._add_images(1)
        self.project.status = Project.Status.CLOSED
        self.project.save(update_fields=["status"])
        self.client.force_authenticate(user=self.supplier.user)
        image = BidProductImage.objects.get()
        res = self.client.delete(f"/api/bids/{self.bid.pk}/images/{image.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(BidProductImage.objects.filter(pk=image.pk).exists())

    # 6. another supplier / visibility
    def test_other_supplier_cannot_upload_to_or_delete_from_someone_elses_bid(self):
        res = self._upload(make_image(), user=self.other.user)
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
        self._add_images(1)
        image = BidProductImage.objects.get()
        res = self.client.delete(f"/api/bids/{self.bid.pk}/images/{image.pk}/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(BidProductImage.objects.filter(pk=image.pk).exists())

    def test_admin_cannot_upload_images(self):
        res = self._upload(make_image(), user=self.admin)
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_only_admin_and_owner_can_read_the_image_file(self):
        self._add_images(1)
        image = BidProductImage.objects.get()
        path = f"/api/files/bidimage/{image.pk}/image/"
        for user, expected in (
            (self.admin, 200), (self.supplier.user, 200),
            (self.other.user, 404), (make_head(), 404),
        ):
            self.client.force_authenticate(user=user)
            res = self.client.get(path)
            self.assertEqual(res.status_code, expected, user.username)
            if expected == 200:
                self.assertEqual(res["Content-Type"], "image/png")
                b"".join(res.streaming_content)
                res.close()
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(path).status_code, 404)

    def test_images_never_reach_other_suppliers_or_the_public_page(self):
        self._add_images(1)
        self.client.force_authenticate(user=self.other.user)
        self.assertEqual(self.client.get("/api/bids/").data, [])
        project_json = str(self.client.get(f"/api/projects/{self.project.pk}/").data)
        self.assertNotIn("bidimage", project_json)
        self.client.force_authenticate(user=None)
        public = str(self.client.get("/api/public/procurement/").data)
        self.assertNotIn("bidimage", public)
        self.assertNotIn("product_images", public)

    # 7 / 8. submission with the option off / on
    def test_bid_submits_without_images_when_option_off(self):
        supplier = make_supplier()
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(res.data["product_images"], [])
        # Documents list is exactly the pre-existing five — no image row added.
        self.assertEqual([d["key"] for d in res.data["documents"]], BID_DOCUMENT_KEYS)

    def test_bid_rejected_without_images_when_option_on(self):
        self.project.require_product_images = True
        self.project.save(update_fields=["require_product_images"])
        supplier = make_supplier()
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Bid.objects.filter(supplier=supplier).exists())

        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/",
            self._bid_payload(product_images=[make_image()], product_image_captions=["front"]),
            format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(len(res.data["product_images"]), 1)
        self.assertEqual(res.data["product_images"][0]["caption"], "front")

    def test_resubmitting_the_bid_without_images_keeps_the_existing_ones(self):
        self.project.require_product_images = True
        self.project.save(update_fields=["require_product_images"])
        self._add_images(2)
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(BidProductImage.objects.filter(bid=self.bid).count(), 2)

    def test_admin_can_set_the_option_when_creating_a_project(self):
        self.client.force_authenticate(user=self.admin)
        data = {
            "name": "Office chairs", "description": "Ergonomic chairs", "type": "Goods",
            "category": "Furniture", "budget": "50000", "delivery_location": "Main Campus",
            "bidding_period_days": "7", "delivery_period_days": "30",
            "purchase_request": dummy_pdf("pr.pdf"), "technical_specifications": dummy_pdf("ts.pdf"),
            "terms_of_reference": dummy_pdf("tor.pdf"), "approved_budget_document": dummy_pdf("abd.pdf"),
            "bid_evaluation_criteria": dummy_pdf("bec.pdf"),
            "require_product_images": "true",
            "product_image_instructions": "Show the exact brand/model.",
        }
        res = self.client.post("/api/projects/", data, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        project = Project.objects.get(pk=res.data["id"])
        self.assertTrue(project.require_product_images)
        self.assertEqual(project.product_image_instructions, "Show the exact brand/model.")

    def test_existing_projects_default_to_option_off(self):
        self.assertFalse(make_project().require_product_images)

    # delete + storage cleanup
    def test_delete_removes_row_and_file_after_commit(self):
        self._add_images(2)
        image = BidProductImage.objects.first()
        stored = image.image.name
        self.client.force_authenticate(user=self.supplier.user)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.delete(f"/api/bids/{self.bid.pk}/images/{image.pk}/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertFalse(BidProductImage.objects.filter(pk=image.pk).exists())
        self.assertFalse(default_storage.exists(stored))
        self.assertTrue(AuditLog.objects.filter(action="bid.image_removed").exists())

    def test_file_is_not_deleted_before_commit(self):
        self._add_images(2)
        image = BidProductImage.objects.first()
        stored = image.image.name
        self.client.force_authenticate(user=self.supplier.user)
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            self.client.delete(f"/api/bids/{self.bid.pk}/images/{image.pk}/")
        self.assertTrue(default_storage.exists(stored))   # still there until commit
        self.assertEqual(len(callbacks), 1)

    def test_storage_delete_failure_is_logged_not_raised(self):
        self._add_images(2)
        image = BidProductImage.objects.first()
        self.client.force_authenticate(user=self.supplier.user)
        with patch.object(FileSystemStorage, "delete", side_effect=OSError("bucket down")), \
                self.assertLogs("procurement.views", level="ERROR") as logs:
            with self.captureOnCommitCallbacks(execute=True):
                res = self.client.delete(f"/api/bids/{self.bid.pk}/images/{image.pk}/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIn("Could not delete bid product image", logs.output[0])

    def test_cannot_delete_last_image_when_required(self):
        self.project.require_product_images = True
        self.project.save(update_fields=["require_product_images"])
        self._add_images(1)
        image = BidProductImage.objects.get()
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.delete(f"/api/bids/{self.bid.pk}/images/{image.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(BidProductImage.objects.filter(pk=image.pk).exists())

    def test_resubmitting_bid_with_new_images_replaces_set_and_deletes_old_files(self):
        self._add_images(2)
        old_names = [img.image.name for img in BidProductImage.objects.all()]
        self.client.force_authenticate(user=self.supplier.user)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(
                f"/api/projects/{self.project.pk}/bid/",
                self._bid_payload(product_images=[make_image()]), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(BidProductImage.objects.filter(bid=self.bid).count(), 1)
        for name in old_names:
            self.assertFalse(default_storage.exists(name))
        self.assertTrue(AuditLog.objects.filter(action="bid.images_replaced").exists())

    # item 5 — revision flow
    def test_admin_can_flag_images_and_supplier_resubmits_after_deadline(self):
        self._add_images(1)
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/bids/{self.bid.pk}/request-revision/",
            {"documents": {"product_images": "Show the actual product, not a catalogue render"}}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        row = next(d for d in res.data["documents"] if d["key"] == "product_images")
        self.assertEqual(row["review_status"], "needs_revision")

        # Winner selection is blocked while flagged, and the message names the images.
        self.bid.refresh_from_db()
        self.bid.status = Bid.Status.QUALIFIED
        self.bid.save(update_fields=["status"])
        res = self.client.post(f"/api/bids/{self.bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Product Images", res.data["detail"])

        # Deadline passes; the flagged images can still be re-submitted.
        self.project.deadline = timezone.localdate() - timedelta(days=1)
        self.project.save(update_fields=["deadline"])
        self.client.force_authenticate(user=self.supplier.user)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(
                f"/api/bids/{self.bid.pk}/resubmit-documents/",
                {"product_images": [make_image(), make_image()]}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.bid.refresh_from_db()
        self.assertEqual(self.bid.document_reviews["product_images"]["status"], "resubmitted")
        self.assertEqual(BidProductImage.objects.filter(bid=self.bid).count(), 2)

    def test_unflagged_images_cannot_be_swapped_after_deadline_via_resubmit(self):
        self._add_images(1)
        self.project.deadline = timezone.localdate() - timedelta(days=1)
        self.project.save(update_fields=["deadline"])
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(
            f"/api/bids/{self.bid.pk}/resubmit-documents/",
            {"product_images": [make_image()]}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(BidProductImage.objects.filter(bid=self.bid).count(), 1)

    def test_document_revision_without_images_is_unchanged(self):
        # Flagging a normal document on a bid with no images adds no image row.
        self.bid.quotation_document = dummy_pdf("q.pdf")
        self.bid.save()
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/bids/{self.bid.pk}/request-revision/",
            {"documents": {"quotation_document": "unsigned"}}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.bid.refresh_from_db()
        self.assertNotIn("product_images", self.bid.document_reviews)

    # anchoring must be untouched
    def test_images_do_not_change_any_anchor_of_an_awarded_project(self):
        self.bid.quotation_document = dummy_pdf("quotation.pdf")
        self.bid.status = Bid.Status.QUALIFIED
        self.bid.save()
        self._add_images(2)   # images present at award time

        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)

        anchors = list(BlockchainAnchor.objects.filter(entity_ref=self.project.code))
        self.assertEqual({a.stage for a in anchors}, {"BID_SUBMITTED", "AWARDED"})
        before = {a.id: a.data_hash for a in anchors}
        for a in anchors:
            self.assertNotIn("product_images", a.payload)
            self.assertEqual(verify_anchor(a, deep=True)["status"], "match")

        # Adding or removing images later changes nothing either.
        BidProductImage.objects.filter(bid=self.bid).first().delete()
        self._add_images(3)
        for a in BlockchainAnchor.objects.filter(entity_ref=self.project.code):
            self.assertEqual(a.data_hash, before[a.id])
            self.assertEqual(verify_anchor(a, deep=True)["status"], "match")
        payload, _ = bid_parts(self.bid, BlockchainAnchor.Stage.BID_SUBMITTED)
        bid_anchor = next(a for a in anchors if a.stage == "BID_SUBMITTED")
        self.assertEqual(hash_payload(payload), bid_anchor.data_hash)

        # The public trail stays hash-only.
        public = str(self.client.get(f"/api/public/procurement/{self.project.code}/anchors/").data)
        self.assertNotIn("bidimage", public)


# ── Category-based supplier documents ────────────────────────────────────────

# Relative dates, so these tests don't start failing once a fixed date passes.
IN_A_YEAR = (timezone.localdate() + timedelta(days=365)).isoformat()
IN_TWO_YEARS = (timezone.localdate() + timedelta(days=730)).isoformat()
LAST_MONTH = (timezone.localdate() - timedelta(days=30)).isoformat()


def attach_base_documents(supplier):
    """Give a supplier every required base document (really written to storage)."""
    for key, _label, required in SUPPLIER_DOCUMENT_FIELDS:
        if required:
            setattr(supplier, key, dummy_pdf(f"{key}.pdf"))
    supplier.save()
    return supplier


def attach_category_document(supplier, key, expiry=IN_A_YEAR):
    return SupplierCategoryDocument.objects.create(
        supplier=supplier, key=key, file=dummy_pdf(f"{key}.pdf"), expiry_date=expiry)


class _TempMediaMixin:
    """Each test writes uploads to its own folder, deleted afterwards."""

    def setUp(self):
        cache.clear()
        self._media = tempfile.mkdtemp()
        self._override = override_settings(MEDIA_ROOT=self._media)
        self._override.enable()
        super().setUp()

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self._media, ignore_errors=True)


class CategoryDocumentRequirementTests(APITestCase):
    """requirements_for() and the import-time registry check."""

    def test_single_category_adds_its_documents_after_the_base_set(self):
        reqs = requirements_for(["Medical Supplies"])
        self.assertEqual([r["key"] for r in reqs[:10]], SUPPLIER_DOCUMENT_KEYS)
        extra = reqs[10:]
        self.assertEqual([r["key"] for r in extra], ["fda_lto"])
        self.assertTrue(extra[0]["required"])
        self.assertTrue(extra[0]["has_expiry"])
        self.assertEqual(extra[0]["category"], "Medical Supplies")
        self.assertEqual(extra[0]["source"], "category")

    def test_multiple_categories_combine_in_category_order(self):
        reqs = requirements_for(["Food & Catering", "Construction"])
        self.assertEqual(
            [r["key"] for r in reqs if r["source"] == "category"],
            ["pcab_license", "sanitary_permit", "food_handler_health_certs", "fda_lto_food"])

    def test_categories_without_extras_need_only_the_base_documents(self):
        for category in ("Office Supplies", "Furniture", "Sports Equipment", "Books & Educational Materials"):
            with self.subTest(category=category):
                self.assertEqual(len(requirements_for([category])), len(SUPPLIER_DOCUMENT_KEYS))

    def test_unknown_category_is_rejected(self):
        with self.assertRaises(ValueError):
            requirements_for(["Spaceships"])

    def test_requirements_endpoint_is_public_and_validates(self):
        res = self.client.get("/api/suppliers/document-requirements/",
                              {"categories": "Medical Supplies,Construction"})
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        keys = [d["key"] for d in res.data]
        self.assertIn("fda_lto", keys)
        self.assertIn("pcab_license", keys)
        bad = self.client.get("/api/suppliers/document-requirements/", {"categories": "Spaceships"})
        self.assertEqual(bad.status_code, status.HTTP_400_BAD_REQUEST)

    def test_registry_check_catches_a_bad_category_name(self):
        with self.assertRaises(ImproperlyConfigured):
            validate_registry({"Medical Supply": [{"key": "fda_x", "label": "X"}]})

    def test_registry_check_catches_a_key_clashing_with_a_base_document(self):
        with self.assertRaises(ImproperlyConfigured):
            validate_registry({"Construction": [{"key": "valid_id", "label": "X"}]})

    def test_registry_check_catches_a_key_used_by_two_categories(self):
        with self.assertRaises(ImproperlyConfigured):
            validate_registry({
                "Construction": [{"key": "shared_doc", "label": "A"}],
                "Furniture": [{"key": "shared_doc", "label": "B"}],
            })

    def test_the_shipped_registry_passes_its_own_check(self):
        validate_registry(CATEGORY_DOCUMENTS)


class CategoryDocumentRegistrationTests(_TempMediaMixin, APITestCase):
    """Registration (self and Admin-assisted) requires each chosen category's
    required documents, with an expiry date where the document has one."""

    def _payload(self, categories, email="medic@example.com", **files):
        data = registration_payload(email)
        data["business_types"] = json.dumps(categories)
        data.update(files)
        return data

    def test_missing_required_category_document_is_rejected(self):
        res = self.client.post("/api/auth/register/supplier/",
                               self._payload(["Medical Supplies"]), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("catdoc_fda_lto", res.data)
        self.assertFalse(Supplier.objects.exists())
        self.assertFalse(User.objects.filter(email="medic@example.com").exists())

    def test_missing_expiry_date_is_rejected(self):
        res = self.client.post(
            "/api/auth/register/supplier/",
            self._payload(["Medical Supplies"], catdoc_fda_lto=dummy_pdf("lto.pdf")),
            format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("catdoc_fda_lto_expiry", res.data)

    def test_registration_succeeds_with_the_document_and_its_expiry(self):
        res = self.client.post(
            "/api/auth/register/supplier/",
            self._payload(["Medical Supplies"], catdoc_fda_lto=dummy_pdf("lto.pdf"),
                          catdoc_fda_lto_expiry=IN_A_YEAR),
            format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        supplier = Supplier.objects.get()
        row = supplier.category_documents.get()
        self.assertEqual(row.key, "fda_lto")
        self.assertEqual(str(row.expiry_date), IN_A_YEAR)
        self.assertTrue(AuditLog.objects.filter(action="supplier.category_documents_uploaded").exists())

    def test_files_for_categories_not_picked_are_ignored(self):
        res = self.client.post(
            "/api/auth/register/supplier/",
            self._payload(["Furniture"], catdoc_pcab_license=dummy_pdf("pcab.pdf"),
                          catdoc_pcab_license_expiry=IN_A_YEAR),
            format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertFalse(SupplierCategoryDocument.objects.exists())

    def test_admin_assisted_registration_follows_the_same_rules(self):
        self.client.force_authenticate(user=make_admin())
        res = self.client.post("/api/auth/admin/register-supplier/",
                               self._payload(["Construction"], email="builder@example.com"),
                               format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("catdoc_pcab_license", res.data)

        res = self.client.post(
            "/api/auth/admin/register-supplier/",
            self._payload(["Construction"], email="builder@example.com",
                          catdoc_pcab_license=dummy_pdf("pcab.pdf"),
                          catdoc_pcab_license_expiry=IN_A_YEAR),
            format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertTrue(SupplierCategoryDocument.objects.filter(key="pcab_license").exists())


class SupplierApprovalDocumentTests(_TempMediaMixin, APITestCase):
    """approve refuses a NEW verification while any required base or category
    document is missing, including a file the database names but storage lost."""

    def setUp(self):
        super().setUp()
        self.admin = make_admin()
        self.supplier = make_supplier(verified=False, categories=["Medical Supplies"])
        self.supplier.email_verified = True
        self.supplier.save(update_fields=["email_verified"])
        self.client.force_authenticate(user=self.admin)
        self.url = f"/api/suppliers/{self.supplier.pk}/approve/"

    def test_blocked_when_a_base_document_is_missing(self):
        res = self.client.post(self.url)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("SEC / DTI Certificate", res.data["detail"])
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.PENDING)
        self.assertTrue(AuditLog.objects.filter(action="supplier.approval_blocked").exists())

    def test_blocked_when_a_category_document_is_missing(self):
        attach_base_documents(self.supplier)
        res = self.client.post(self.url)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(res.data["missing"], ["FDA License to Operate (Medical Device Distributor) (not uploaded)"])

    def test_blocked_when_a_file_no_longer_exists_in_storage(self):
        attach_base_documents(self.supplier)
        attach_category_document(self.supplier, "fda_lto")
        default_storage.delete(self.supplier.valid_id.name)   # lost, like an old Render restart
        res = self.client.post(self.url)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(res.data["missing"], ["Valid Government ID (file missing from storage)"])

    def test_approves_when_everything_is_on_file(self):
        attach_base_documents(self.supplier)
        attach_category_document(self.supplier, "fda_lto")
        res = self.client.post(self.url)
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)

    def test_detail_lists_category_documents_with_missing_flag(self):
        attach_base_documents(self.supplier)
        res = self.client.get(f"/api/suppliers/{self.supplier.pk}/")
        doc = next(d for d in res.data["documents"] if d["key"] == "fda_lto")
        self.assertEqual(doc["category"], "Medical Supplies")
        self.assertTrue(doc["missing"])
        self.assertIsNone(doc["url"])
        base = next(d for d in res.data["documents"] if d["key"] == "valid_id")
        self.assertFalse(base["missing"])

    def test_list_reports_documents_complete(self):
        res = self.client.get("/api/suppliers/")
        self.assertFalse(next(s for s in res.data if s["id"] == self.supplier.pk)["documents_complete"])
        attach_base_documents(self.supplier)
        attach_category_document(self.supplier, "fda_lto")
        res = self.client.get("/api/suppliers/")
        self.assertTrue(next(s for s in res.data if s["id"] == self.supplier.pk)["documents_complete"])


class ExistingVerifiedSupplierTests(APITestCase):
    """Suppliers verified before category documents existed keep everything."""

    def test_keeps_verification_and_eligibility_without_category_documents(self):
        supplier = make_supplier(verified=True, categories=["Medical Supplies"])
        project = make_project(category="Medical Supplies")
        self.client.force_authenticate(user=supplier.user)
        res = self.client.get("/api/projects/")
        self.assertIn(project.pk, [p["id"] for p in res.data])

        # Re-approving an already-verified supplier is never blocked.
        admin = make_admin()
        self.client.force_authenticate(user=admin)
        supplier.email_verified = True
        supplier.save(update_fields=["email_verified"])
        res = self.client.post(f"/api/suppliers/{supplier.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        supplier.refresh_from_db()
        self.assertEqual(supplier.qualification_status, Supplier.Qualification.VERIFIED)


class CategoryChangeDocumentTests(_TempMediaMixin, APITestCase):
    """A new category is only granted once its required licenses are on file."""

    def setUp(self):
        super().setUp()
        self.admin = make_admin()
        self.supplier = attach_base_documents(make_supplier(verified=True, categories=["IT Equipment"]))
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/",
                                {"business_types": ["IT Equipment", "Construction"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)

    def _upload(self, **files):
        self.client.force_authenticate(user=self.supplier.user)
        return self.client.post("/api/suppliers/me/category-documents/", files, format="multipart")

    def _approve(self):
        self.client.force_authenticate(user=self.admin)
        return self.client.post(f"/api/suppliers/{self.supplier.pk}/approve-categories/")

    def test_approve_categories_blocked_until_the_new_license_is_uploaded(self):
        res = self._approve()
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("PCAB Contractor's License (not uploaded)", res.data["missing"])
        self.assertTrue(AuditLog.objects.filter(action="supplier.category_change_blocked").exists())

        res = self._upload(catdoc_pcab_license=dummy_pdf("pcab.pdf"),
                           catdoc_pcab_license_expiry=IN_A_YEAR)
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.assertTrue(AuditLog.objects.filter(action="supplier.category_documents_uploaded").exists())

        res = self._approve()
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment", "Construction"])
        self.assertEqual(self.supplier.document_reviews["pcab_license"]["status"], "approved")

    def test_upload_requires_the_expiry_date(self):
        res = self._upload(catdoc_pcab_license=dummy_pdf("pcab.pdf"))
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("catdoc_pcab_license_expiry", res.data)

    def test_upload_for_a_category_not_requested_is_refused(self):
        res = self._upload(catdoc_fda_lto=dummy_pdf("lto.pdf"), catdoc_fda_lto_expiry=IN_A_YEAR)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(SupplierCategoryDocument.objects.exists())

    def test_an_accepted_license_cannot_be_swapped_without_a_flag(self):
        supplier = attach_base_documents(make_supplier(verified=True, categories=["Medical Supplies"]))
        attach_category_document(supplier, "fda_lto")
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post("/api/suppliers/me/category-documents/",
                               {"catdoc_fda_lto": dummy_pdf("new.pdf"), "catdoc_fda_lto_expiry": IN_TWO_YEARS},
                               format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_flagging_a_new_license_keeps_the_supplier_verified(self):
        self._upload(catdoc_pcab_license=dummy_pdf("pcab.pdf"), catdoc_pcab_license_expiry=IN_A_YEAR)
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/request-revision/",
                               {"documents": {"pcab_license": "Expired copy"}}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)

        res = self._approve()
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("PCAB Contractor's License", res.data["flagged"])

        res = self._upload(catdoc_pcab_license=dummy_pdf("pcab2.pdf"), catdoc_pcab_license_expiry=IN_TWO_YEARS)
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.document_reviews["pcab_license"]["status"], "resubmitted")
        self.assertEqual(self._approve().status_code, status.HTTP_200_OK)


class CategoryDocumentExpiryTests(_TempMediaMixin, APITestCase):
    """An expired license counts as missing for NEW approvals; a license about
    to expire is flagged but still valid; nobody already verified loses access."""

    def setUp(self):
        super().setUp()
        self.admin = make_admin()

    def _pending(self, categories):
        supplier = attach_base_documents(make_supplier(verified=False, categories=categories))
        supplier.email_verified = True
        supplier.save(update_fields=["email_verified"])
        return supplier

    def _approve(self, supplier):
        self.client.force_authenticate(user=self.admin)
        return self.client.post(f"/api/suppliers/{supplier.pk}/approve/")

    def test_expired_category_license_blocks_approval(self):
        supplier = self._pending(["Medical Supplies"])
        attach_category_document(supplier, "fda_lto", expiry=LAST_MONTH)
        res = self._approve(supplier)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(res.data["missing"],
                         [f"FDA License to Operate (Medical Device Distributor) (expired {LAST_MONTH})"])
        self.assertIn(f"expired {LAST_MONTH}", res.data["detail"])

    def test_expired_mayors_permit_blocks_approval(self):
        supplier = self._pending(["Furniture"])
        supplier.mayors_permit_expiry = LAST_MONTH
        supplier.save(update_fields=["mayors_permit_expiry"])
        res = self._approve(supplier)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(res.data["missing"], [f"Mayor's / Business Permit (expired {LAST_MONTH})"])

    def test_license_expiring_in_ten_days_is_flagged_but_does_not_block(self):
        supplier = self._pending(["Medical Supplies"])
        soon = (timezone.localdate() + timedelta(days=10)).isoformat()
        attach_category_document(supplier, "fda_lto", expiry=soon)

        self.client.force_authenticate(user=self.admin)
        detail = self.client.get(f"/api/suppliers/{supplier.pk}/").data
        doc = next(d for d in detail["documents"] if d["key"] == "fda_lto")
        self.assertTrue(doc["expiring_soon"])
        self.assertEqual(doc["days_left"], 10)
        self.assertFalse(doc["missing"])
        row = next(s for s in self.client.get("/api/suppliers/").data if s["id"] == supplier.pk)
        self.assertFalse(row["documents_complete"])   # "incomplete or expired" badge

        self.assertEqual(self._approve(supplier).status_code, status.HTTP_200_OK)

    def test_past_expiry_date_is_rejected_at_registration(self):
        data = registration_payload("late@example.com")
        data["business_types"] = json.dumps(["Medical Supplies"])
        data.update(catdoc_fda_lto=dummy_pdf("lto.pdf"), catdoc_fda_lto_expiry=LAST_MONTH)
        res = self.client.post("/api/auth/register/supplier/", data, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("expired", str(res.data["catdoc_fda_lto_expiry"]))

        data = registration_payload("late2@example.com")
        data["mayors_permit_expiry"] = LAST_MONTH
        res = self.client.post("/api/auth/register/supplier/", data, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("mayors_permit_expiry", res.data)
        self.assertFalse(Supplier.objects.exists())

    def test_past_expiry_date_is_rejected_at_upload(self):
        supplier = attach_base_documents(make_supplier(verified=True, categories=["IT Equipment"]))
        self.client.force_authenticate(user=supplier.user)
        self.client.patch("/api/suppliers/me/", {"business_types": ["IT Equipment", "Construction"]},
                          format="json")
        res = self.client.post("/api/suppliers/me/category-documents/",
                               {"catdoc_pcab_license": dummy_pdf("pcab.pdf"),
                                "catdoc_pcab_license_expiry": LAST_MONTH}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("expired", str(res.data["catdoc_pcab_license_expiry"]))
        self.assertFalse(SupplierCategoryDocument.objects.exists())

    def test_verified_supplier_with_expired_license_keeps_eligibility_and_can_renew(self):
        supplier = attach_base_documents(make_supplier(verified=True, categories=["Medical Supplies"]))
        attach_category_document(supplier, "fda_lto", expiry=LAST_MONTH)
        project = make_project(category="Medical Supplies")

        self.client.force_authenticate(user=supplier.user)
        self.assertIn(project.pk, [p["id"] for p in self.client.get("/api/projects/").data])
        doc = next(d for d in self.client.get("/api/suppliers/me/").data["documents"] if d["key"] == "fda_lto")
        self.assertTrue(doc["expired"])

        res = self.client.post("/api/suppliers/me/category-documents/",
                               {"catdoc_fda_lto": dummy_pdf("renewed.pdf"),
                                "catdoc_fda_lto_expiry": IN_A_YEAR}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        supplier.refresh_from_db()
        self.assertEqual(supplier.qualification_status, Supplier.Qualification.VERIFIED)
        self.assertEqual(str(supplier.category_documents.get(key="fda_lto").expiry_date), IN_A_YEAR)


class DashboardSummaryTests(APITestCase):
    """Read-only dashboard summaries: correct counts, role-scoped, and the
    public one never leaks private bid or supplier data."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.supplier = make_supplier()
        rival = make_supplier()
        today = timezone.localdate()
        self.open = make_project()
        Project.objects.filter(pk=self.open.pk).update(deadline=today + timedelta(days=2), budget=100000)
        make_project(status=Project.Status.PENDING_HEAD)
        make_project(status=Project.Status.NEEDS_REVISION)
        self.closed = make_project(status=Project.Status.CLOSED)
        Project.objects.filter(pk=self.closed.pk).update(deadline=today - timedelta(days=1))
        Bid.objects.create(project=self.closed, supplier=self.supplier, amount=40000)
        self.losing = Bid.objects.create(project=self.closed, supplier=rival, amount=48765)
        awarded = make_project(status=Project.Status.AWARDED)
        win = Bid.objects.create(project=awarded, supplier=self.supplier, amount=45000, status=Bid.Status.WINNER)
        Bid.objects.create(project=awarded, supplier=rival, amount=47321, status=Bid.Status.QUALIFIED)
        self.award = Award.objects.create(project=awarded, supplier=self.supplier, bid=win, amount=45000)
        record_anchor(BlockchainAnchor.EntityType.PROJECT, self.open.code, "SUBMITTED", {"a": 1},
                      entity_id=self.open.id)

    def get(self, url, user=None):
        if user:
            self.client.force_authenticate(user=user)
        return self.client.get(url)

    def test_admin_summary_counts(self):
        res = self.get("/api/dashboard/admin-summary/", self.admin)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        k = res.data["kpis"]
        self.assertEqual(k["open_biddings"], 1)
        self.assertEqual(k["closing_this_week"], 1)
        self.assertEqual(k["bids_awaiting_evaluation"], 2)
        self.assertEqual(k["bids_awaiting_on_closed"], 2)
        self.assertEqual(k["anchors_pending"], 1)
        self.assertEqual(float(k["open_abc"]), 100000)
        pipeline = {row["key"]: row["count"] for row in res.data["pipeline"]}
        self.assertEqual(pipeline["pending_head"], 1)
        self.assertEqual(pipeline["needs_revision"], 1)
        self.assertEqual(pipeline["evaluation"], 1)
        self.assertEqual(pipeline["awarded"], 1)
        self.assertEqual(float(res.data["savings"]["total_saved"]), 5000)
        kinds = [i["kind"] for i in res.data["attention"]]
        self.assertEqual(kinds[0], "evaluate")   # most urgent first
        self.assertIn("award_docs", kinds)
        self.assertEqual(res.data["chain"]["pending_items"][0]["stage"], "SUBMITTED")

    def test_admin_summary_is_read_only(self):
        self.client.force_authenticate(user=self.admin)
        before = (Project.objects.count(), Bid.objects.count(), BlockchainAnchor.objects.count())
        self.client.get("/api/dashboard/admin-summary/")
        self.assertEqual(self.client.post("/api/dashboard/admin-summary/").status_code,
                         status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertEqual(before, (Project.objects.count(), Bid.objects.count(), BlockchainAnchor.objects.count()))

    def test_head_summary_counts(self):
        reviewed = make_project(status=Project.Status.APPROVED)
        Project.objects.filter(pk=reviewed.pk).update(reviewed_at=timezone.now())
        res = self.get("/api/dashboard/head-summary/", self.head)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["kpis"]["waiting"], 1)
        self.assertEqual(res.data["kpis"]["returned_for_revision"], 1)
        self.assertEqual(res.data["kpis"]["approved_this_month"], 1)
        self.assertEqual(len(res.data["queue"]), 1)
        self.assertEqual(res.data["history"][0]["decision"], "approved")

    def test_each_role_only_reads_its_own_summary(self):
        cases = {
            "/api/dashboard/admin-summary/": self.admin,
            "/api/dashboard/head-summary/": self.head,
        }
        for url, owner in cases.items():
            for user in (self.admin, self.head, self.supplier.user):
                self.client.force_authenticate(user=user)
                expected = status.HTTP_200_OK if user == owner else status.HTTP_403_FORBIDDEN
                self.assertEqual(self.client.get(url).status_code, expected, (url, user.username))
            self.client.force_authenticate(user=None)
            self.assertEqual(self.client.get(url).status_code, status.HTTP_401_UNAUTHORIZED)

    def test_public_summary_counts_without_login(self):
        res = self.client.get("/api/public/summary/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["open_biddings"], 1)
        self.assertEqual(res.data["awarded_contracts"], 1)
        # published + closed + awarded = 100000 + 50000 + 50000
        self.assertEqual(float(res.data["total_published_abc"]), 200000)
        self.assertEqual(res.data["awards"][0]["winner"], self.supplier.company)
        self.assertFalse(res.data["awards"][0]["anchored"])

    def test_public_summary_exposes_no_private_fields(self):
        res = self.client.get("/api/public/summary/")
        body = json.dumps(res.data, default=str)
        # Losing bid amounts never appear; the winning amount is the published award.
        self.assertNotIn("48765", body)
        self.assertNotIn("47321", body)
        for private in ("contact", "email", "Jane Dela Cruz", "tin", "phone", "documents",
                        "payload", "data_hash", "reference_image", "supplier_id"):
            self.assertNotIn(private, body)
        self.assertEqual(set(res.data["awards"][0]),
                         {"code", "name", "category", "winner", "amount", "awarded_at", "anchored", "explorer_url"})
        self.assertEqual(set(res.data["open"][0]),
                         {"code", "name", "category", "budget", "deadline", "published_at", "bids"})
