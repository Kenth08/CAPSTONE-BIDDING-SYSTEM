import hashlib
import io
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.core import mail
from django.core.cache import cache
from django.core.signals import request_finished
from django.core.management import call_command
from django.core.management.base import CommandError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.files.storage import FileSystemStorage, default_storage
from django.core.files.base import ContentFile
from django.db import close_old_connections, transaction
from django.db.models import QuerySet
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from PIL import Image

from accounts.models import AuditLog

from .blockchain import (
    _commit_bids, anchor_events, anchor_summary, bid_leaf, bid_leaf_fields, bid_parts, confirm_anchor,
    attach_transaction, inclusion_receipt, hash_file, hash_payload, needs_chain_check, read_chain_anchors,
    record_anchor,
    submit_anchor_server_side, verify_anchor,
)
from accounts.tests import registration_payload

from . import blockchain, openings, payload_v3
from .canonical import NonCanonicalPayload, validate_canonical
from .serializers import ProjectSerializer
from .document_requirements import CATEGORY_DOCUMENTS, requirements_for, validate_registry
from .models import (
    AwardDocumentVersion, CommitmentOpening, PROCUREMENT_CATEGORIES, ProcurementCategory,
    PROCUREMENT_DOCUMENT_KEYS, ProjectDocumentVersion,
    BID_DOCUMENT_KEYS, SUPPLIER_DOCUMENT_FIELDS, SUPPLIER_DOCUMENT_KEYS, Award, Bid, BidProductImage,
    BlockchainAnchor, Notification, Project, Supplier, SupplierCategoryDocument,
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
        # No BID_QUALIFIED: qualification happens for every bidder and is not
        # anchored one by one. At award time the whole evaluation is committed
        # once (EVALUATION_COMPLETED, salted — no amounts), then the winning
        # bid (BID_SUBMITTED, written at award even though the bid came much
        # earlier) and the award, so the trail reads evaluation-offer-award.
        self.assertEqual(stages, [
            BlockchainAnchor.Stage.HEAD_APPROVED,
            BlockchainAnchor.Stage.BIDDING_OPEN,
            BlockchainAnchor.Stage.EVALUATION_COMPLETED,
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
        # Only published/closed/awarded procurements have a public trail.
        Project.objects.filter(pk=self.project.pk).update(status=Project.Status.PUBLISHED)

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
        # Only published/closed/awarded procurements have a public trail.
        Project.objects.filter(pk=self.project.pk).update(status=Project.Status.PUBLISHED)
        Project.objects.filter(pk=self.project.pk).update(budget=999999)

        self.client.force_authenticate(user=None)   # a member of the public
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["altered_count"], 1)
        self.assertEqual(res.data["anchors"][0]["integrity"]["status"], "mismatch")

    def test_public_trail_skips_document_hashing_unless_asked(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{self.project.pk}/approve/")
        # Only published/closed/awarded procurements have a public trail.
        Project.objects.filter(pk=self.project.pk).update(status=Project.Status.PUBLISHED)
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
        # record stands, and the UI offers "Anchor now". A real node refusal: any
        # other error may mean it was sent (ServerSendNeverRepeatsTests).
        from web3.exceptions import Web3RPCError
        Web3, _, _ = self._fake_web3(send_raises=Web3RPCError(
            "{'code': -32000, 'message': 'insufficient funds for gas * price + value'}"))
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

SEPOLIA = 11155111
CHAIN_HEAD = 12_000_000          # the fake node's latest block


def ledger_event(anchor, ledger, *, anchor_id=7, log_index=0, **overrides):
    """A decoded AnchorRecorded event (as anchor_events returns it) recording `anchor`."""
    ev = {"address": ledger, "id": anchor_id, "logIndex": log_index,
          "entityType": anchor.entity_type, "entityRef": anchor.entity_ref,
          "stage": anchor.stage, "dataHash": anchor.data_hash,
          "actor": "0x" + "11" * 20, "timestamp": 1_762_000_000}
    ev.update(overrides)
    return ev


def state_row(ev):
    """What the contract's getAnchor(ev.id) returns for an honest event."""
    return (ev["entityType"], ev["entityRef"], ev["stage"], ev["dataHash"], ev["actor"], ev["timestamp"])


def sepolia_node(receipt=None, *, receipt_missing=False, tx_known=True, state=None,
                 finalized=CHAIN_HEAD - 64, chain_id=SEPOLIA):
    """A fake web3 that answers like a Sepolia node: chain id, latest and
    finalized blocks, receipts, and the ledger's getAnchor(id) from `state`
    ({id: row}; an id not in it reverts like the real contract)."""
    w3 = MagicMock(name="w3")
    w3.eth.chain_id = chain_id
    w3.eth.block_number = CHAIN_HEAD
    w3.eth.get_block.return_value = {"number": finalized}
    if receipt_missing:
        w3.eth.get_transaction_receipt.side_effect = NotFound()
    else:
        w3.eth.get_transaction_receipt.return_value = receipt
    if not tx_known:
        w3.eth.get_transaction.side_effect = NotFound()
    rows = {} if state is None else state

    def get_anchor(anchor_id):
        if anchor_id not in rows:
            raise ValueError("execution reverted: ProcurementLedger: unknown anchor")
        return MagicMock(**{"call.return_value": rows[anchor_id]})

    w3.eth.contract.return_value.functions.getAnchor.side_effect = get_anchor
    return w3


class AnchorConfirmationTests(APITestCase):
    """confirm_anchor / `confirm_anchors`: a record may only stay "On-chain" if
    the chain agrees. Server-signed transactions are recorded when SENT, so this
    is the step that catches one that later fails or is never mined."""

    TX = "0x" + "ab" * 32
    LEDGER = "0x" + "12" * 20

    def setUp(self):
        # confirm_anchor can only say "confirmed" against a configured ledger.
        patcher = patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state = {}     # the fake ledger's storage, filled by _event_for

    def _event_for(self, anchor, **overrides):
        ev = ledger_event(anchor, self.LEDGER, **overrides)
        self.state[ev["id"]] = state_row(ev)
        return ev

    def _sent(self, minutes_ago=5):
        return BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.AWARD, entity_ref="P-2026-007",
            entity_id="31", stage=BlockchainAnchor.Stage.NOA_ISSUED, data_hash="0x" + "cd" * 32,
            tx_hash=self.TX, actor_address="0x" + "11" * 20,
            anchored_at=timezone.now() - timedelta(minutes=minutes_ago),
        )

    def _w3(self, receipt=None, receipt_missing=False, tx_known=True):
        return sepolia_node(receipt, receipt_missing=receipt_missing, tx_known=tx_known, state=self.state)

    def test_a_successful_transaction_recording_this_anchor_is_confirmed(self):
        anchor = self._sent()
        receipt = {"status": 1, "blockNumber": 11962500, "to": self.LEDGER}
        with patch("procurement.blockchain.anchor_events", return_value=[self._event_for(anchor)]):
            outcome = confirm_anchor(anchor, w3=self._w3(receipt))
        anchor.refresh_from_db()
        self.assertEqual(outcome, "confirmed")
        self.assertEqual(anchor.block_number, 11962500)
        self.assertEqual(anchor.tx_hash, self.TX)
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.CONFIRMED)
        self.assertTrue(anchor.verified_on_chain)

    def test_a_successful_receipt_without_the_matching_event_is_a_mismatch(self):
        # A real, successful transaction hash pasted onto the wrong record, or
        # any tx at all: receipt status 1 alone used to be enough to confirm.
        cases = {
            "no event": None,
            "wrong hash": {"dataHash": "0x" + "ee" * 32},
            "wrong stage": {"stage": "AWARDED"},
            "wrong code": {"entityRef": "PC-OTHER"},
            "wrong entity type": {"entityType": "PROJECT"},
        }
        for name, overrides in cases.items():
            with self.subTest(name):
                anchor = self._sent()
                events = [] if overrides is None else [self._event_for(anchor, **overrides)]
                receipt = {"status": 1, "blockNumber": 5, "to": self.LEDGER}
                with patch("procurement.blockchain.anchor_events", return_value=events):
                    self.assertEqual(confirm_anchor(anchor, w3=self._w3(receipt)), "mismatch")
                anchor.refresh_from_db()
                self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.MISMATCH)
                self.assertEqual(anchor.tx_hash, self.TX)          # kept, visibly flagged
                self.assertFalse(anchor.verified_on_chain)
                self.assertIsNone(anchor.block_number)
        self.assertTrue(AuditLog.objects.filter(action="blockchain.mismatch").exists())

    def test_a_ledger_event_counts_even_when_sent_through_a_smart_account(self):
        # Regression from the LIVE Sepolia ledger (anchors #11-#14): the wallet
        # sent the tx to a smart-account/batch executor, which called the
        # ledger. receipt.to is the executor, but the ledger's own event is in
        # the receipt — that event is the proof, so this is CONFIRMED.
        anchor = self._sent()
        receipt = {"status": 1, "blockNumber": 5, "to": "0x" + "db" * 20}
        with patch("procurement.blockchain.anchor_events", return_value=[self._event_for(anchor)]):
            self.assertEqual(confirm_anchor(anchor, w3=self._w3(receipt)), "confirmed")

    def test_without_a_configured_ledger_nothing_is_confirmed(self):
        anchor = self._sent()
        with patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", ""):
            outcome = confirm_anchor(anchor, w3=self._w3({"status": 1, "blockNumber": 1}))
        self.assertEqual(outcome, "unknown")
        anchor.refresh_from_db()
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.UNCHECKED)

    def test_a_mismatched_anchor_can_be_signed_again(self):
        project = make_project()
        anchor = BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=project.code, entity_id=str(project.pk),
            stage="BIDDING_OPEN", data_hash="0x" + "cd" * 32, tx_hash=self.TX,
            chain_status=BlockchainAnchor.ChainStatus.MISMATCH)
        self.client.force_authenticate(user=make_admin())
        new_tx = "0x" + "cd" * 32
        res = self.client.post(f"/api/projects/{project.pk}/anchor/",
                               {"anchor_id": anchor.pk, "tx_hash": new_tx}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, new_tx)
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.UNCHECKED)

    def test_a_reported_but_unconfirmed_anchor_is_not_re_signed(self):
        # Idempotency still holds for anything that isn't a known mismatch.
        project = make_project()
        anchor = BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=project.code, entity_id=str(project.pk),
            stage="BIDDING_OPEN", data_hash="0x" + "cd" * 32, tx_hash=self.TX)
        self.client.force_authenticate(user=make_admin())
        self.client.post(f"/api/projects/{project.pk}/anchor/",
                         {"anchor_id": anchor.pk, "tx_hash": "0x" + "ef" * 32}, format="json")
        anchor.refresh_from_db()
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

    def test_a_pruned_node_never_erases_an_anchor_the_ledger_still_holds(self):
        # Found against the LIVE ledger: the default public RPC prunes old
        # receipts AND can forget old transactions. "Unknown to the node" used
        # to mean DROPPED -> the genuine tx hash was cleared. Contract storage
        # isn't pruned, so if it still holds the record, nothing is touched.
        stale = self._sent(minutes_ago=600)
        w3 = self._w3(receipt_missing=True, tx_known=False)
        held = [(stale.entity_type, stale.entity_ref, stale.stage, stale.data_hash, "0x" + "11" * 20, 1)]
        w3.eth.contract.return_value.functions.getAnchorsByRef.return_value.call.return_value = held
        self.assertEqual(confirm_anchor(stale, w3=w3), "unknown")
        stale.refresh_from_db()
        self.assertEqual(stale.tx_hash, self.TX)
        self.assertFalse(AuditLog.objects.filter(action="blockchain.dropped").exists())

    def test_a_node_error_changes_nothing(self):
        # An RPC outage is not evidence that the transaction failed.
        anchor = self._sent()
        w3 = self._w3()
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

    def test_the_command_skips_anchors_already_confirmed_reconciled_and_final(self):
        BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT, entity_ref="P-2026-001",
            stage=BlockchainAnchor.Stage.HEAD_APPROVED, data_hash="0x" + "cd" * 32,
            tx_hash=self.TX, block_number=100, chain_status=BlockchainAnchor.ChainStatus.CONFIRMED,
            chain_anchor_id=3, chain_id=SEPOLIA, chain_contract=self.LEDGER, chain_finalized=True,
        )
        w3 = MagicMock()
        with patch("procurement.blockchain.web3_client", return_value=w3):
            call_command("confirm_anchors", "--apply", stdout=io.StringIO())
        w3.eth.get_transaction_receipt.assert_not_called()

    def test_the_command_checks_metamask_anchors_that_carry_a_block_number(self):
        # MetaMask attaches post the browser's block number, which used to make
        # the command skip the anchor as if that number were proof.
        anchor = BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT, entity_ref="P-2026-001",
            stage=BlockchainAnchor.Stage.HEAD_APPROVED, data_hash="0x" + "cd" * 32,
            tx_hash=self.TX, block_number=100, anchored_at=timezone.now(),
        )
        w3 = self._w3({"status": 1, "blockNumber": 101, "to": self.LEDGER})
        with patch("procurement.blockchain.web3_client", return_value=w3), \
                patch("procurement.blockchain.anchor_events", return_value=[]):
            call_command("confirm_anchors", "--apply", stdout=io.StringIO())
        w3.eth.get_transaction_receipt.assert_called_once_with(self.TX)
        anchor.refresh_from_db()
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.MISMATCH)

    def test_the_command_never_raises(self):
        # It runs inside the Render build; a failure here must not fail a deploy.
        self._sent()
        with patch("procurement.blockchain.web3_client", side_effect=RuntimeError("boom")):
            call_command("confirm_anchors", "--apply", stdout=io.StringIO(), stderr=io.StringIO())


class AnchorEventDecodingTests(APITestCase):
    """anchor_events() against a REAL ABI-encoded AnchorRecorded log, decoded by
    web3 with procurement/ProcurementLedger.abi.json and no network involved. The
    mocked tests above stand in for this function; this proves it reads the
    actual event layout the deployed contract emits."""

    def setUp(self):
        from web3 import Web3
        self.Web3 = Web3
        self.ledger = Web3.to_checksum_address("0x" + "12" * 20)
        patcher = patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.ledger)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.w3 = Web3()   # no provider needed: decoding is local

    def _log(self, address, entity_type, ref, stage, data_hash, anchor_id=7, log_index=0):
        from eth_abi import encode
        topic0 = self.Web3.keccak(text="AnchorRecorded(uint256,string,string,string,string,address,uint256)")
        data = encode(["string", "string", "string", "string", "address", "uint256"],
                      [entity_type, ref, stage, data_hash, "0x" + "33" * 20, 1700000000])
        return {
            "address": address, "topics": [topic0, anchor_id.to_bytes(32, "big")], "data": data,
            "blockNumber": 9, "blockHash": b"\x01" * 32, "transactionHash": b"\x02" * 32,
            "transactionIndex": 0, "logIndex": log_index, "removed": False,
        }

    def test_decodes_our_event_and_ignores_look_alike_contracts(self):
        h = "0x" + "cd" * 32
        other = self.Web3.to_checksum_address("0x" + "99" * 20)
        receipt = {"status": 1, "blockNumber": 9, "to": self.ledger, "logs": [
            self._log(self.ledger, "AWARD", "PC-AAAA-BBBB-CCCC", "AWARDED", h),
            self._log(other, "AWARD", "PC-AAAA-BBBB-CCCC", "AWARDED", h),
        ]}
        events = anchor_events(self.w3, receipt)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["entityRef"], "PC-AAAA-BBBB-CCCC")
        self.assertEqual(events[0]["stage"], "AWARDED")
        self.assertEqual(events[0]["dataHash"], h)
        # The on-chain identity comes from the event itself.
        self.assertEqual(events[0]["id"], 7)
        self.assertEqual(events[0]["logIndex"], 0)
        self.assertEqual(events[0]["timestamp"], 1700000000)
        self.assertEqual(events[0]["actor"].lower(), "0x" + "33" * 20)

    def test_confirm_anchor_end_to_end_with_a_real_encoded_receipt(self):
        h = "0x" + "cd" * 32
        anchor = BlockchainAnchor.objects.create(
            entity_type="AWARD", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="1", stage="AWARDED",
            data_hash=h, tx_hash="0x" + "ab" * 32, anchored_at=timezone.now())
        good = {"status": 1, "blockNumber": 9, "to": self.ledger,
                "logs": [self._log(self.ledger, "AWARD", "PC-AAAA-BBBB-CCCC", "AWARDED", h)]}
        with patch.object(self.w3.eth, "get_transaction_receipt", return_value=good), self._chain():
            self.assertEqual(confirm_anchor(anchor, w3=self.w3), "confirmed")
        anchor.refresh_from_db()
        self.assertEqual(anchor.block_number, 9)
        self.assertEqual((anchor.chain_anchor_id, anchor.chain_log_index), (7, 0))
        self.assertEqual(int(anchor.chain_timestamp.timestamp()), 1700000000)

        # The same genuine transaction reused for a DIFFERENT anchor.
        other = BlockchainAnchor.objects.create(
            entity_type="AWARD", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="1", stage="NOA_ISSUED",
            data_hash="0x" + "ef" * 32, tx_hash="0x" + "ab" * 32, anchored_at=timezone.now())
        with patch.object(self.w3.eth, "get_transaction_receipt", return_value=good), self._chain():
            self.assertEqual(confirm_anchor(other, w3=self.w3), "mismatch")

    def _chain(self):
        """The node-facing parts a provider-less Web3 can't answer: Sepolia,
        a final block, and contract state that agrees with the event."""
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch("procurement.blockchain.network_check", return_value=(True, SEPOLIA)))
        stack.enter_context(patch("procurement.blockchain.finality", return_value=(40, True)))
        stack.enter_context(patch("procurement.blockchain._state_agrees", return_value=True))
        return stack

    def test_a_batched_transaction_gives_each_identical_record_its_own_on_chain_id(self):
        # Two identical records sent in one batch (smart-account wallets do
        # this): each event vouches for exactly one anchor row.
        h = "0x" + "cd" * 32
        rows = [BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="1", stage="HEAD_APPROVED",
            data_hash=h, tx_hash="0x" + "ab" * 32, anchored_at=timezone.now()) for _ in range(2)]
        batch = {"status": 1, "blockNumber": 9, "to": "0x" + "db" * 20, "logs": [
            self._log(self.ledger, "PROJECT", "PC-AAAA-BBBB-CCCC", "HEAD_APPROVED", h, anchor_id=8, log_index=3),
            self._log(self.ledger, "PROJECT", "PC-AAAA-BBBB-CCCC", "HEAD_APPROVED", h, anchor_id=7, log_index=1),
        ]}
        with patch.object(self.w3.eth, "get_transaction_receipt", return_value=batch), self._chain():
            self.assertEqual([confirm_anchor(a, w3=self.w3) for a in rows], ["confirmed", "confirmed"])
            for a in rows:
                a.refresh_from_db()
            self.assertEqual([(a.chain_anchor_id, a.chain_log_index) for a in rows], [(7, 1), (8, 3)])
            # A third identical row can't reuse either event.
            third = BlockchainAnchor.objects.create(
                entity_type="PROJECT", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="1", stage="HEAD_APPROVED",
                data_hash=h, tx_hash="0x" + "ab" * 32, anchored_at=timezone.now())
            self.assertEqual(confirm_anchor(third, w3=self.w3), "mismatch")
        self.assertIn("already back another anchor",
                      AuditLog.objects.filter(action="blockchain.mismatch").latest("id").description)


class VerifyChainEndpointTests(APITestCase):
    """POST /projects/{id}/verify-chain/: the on-demand version of
    confirm_anchors for one procurement. Admin and Head only."""

    LEDGER = "0x" + "12" * 20

    def setUp(self):
        cache.clear()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.anchor = BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
            stage="BIDDING_OPEN", data_hash="0x" + "cd" * 32, tx_hash="0x" + "ab" * 32,
            anchored_at=timezone.now())

    def test_admin_and_head_can_run_it_and_it_confirms(self):
        event = ledger_event(self.anchor, self.LEDGER)
        w3 = sepolia_node({"status": 1, "blockNumber": 77, "to": self.LEDGER},
                          state={event["id"]: state_row(event)})
        for user in (make_admin(), make_head()):
            BlockchainAnchor.objects.filter(pk=self.anchor.pk).update(
                chain_status="unchecked", chain_anchor_id=None)
            self.client.force_authenticate(user=user)
            with patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER), \
                    patch("procurement.blockchain.web3_client", return_value=w3), \
                    patch("procurement.blockchain.anchor_events", return_value=[event]):
                res = self.client.post(f"/api/projects/{self.project.pk}/verify-chain/")
            self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
            self.assertEqual(res.data["checked"][0]["outcome"], "confirmed")
            self.assertTrue(res.data["anchors"][0]["verified_on_chain"])
            self.assertEqual(res.data["anchors"][0]["chain_anchor_id"], 7)

    def test_on_the_wrong_network_it_checks_nothing_and_says_so(self):
        w3 = sepolia_node({"status": 1, "blockNumber": 77}, chain_id=1)   # Ethereum mainnet
        self.client.force_authenticate(user=make_admin())
        with patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER), \
                patch("procurement.blockchain.web3_client", return_value=w3):
            res = self.client.post(f"/api/projects/{self.project.pk}/verify-chain/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["checked"], [])
        self.assertIn("not Sepolia", res.data["detail"])
        w3.eth.get_transaction_receipt.assert_not_called()
        self.anchor.refresh_from_db()
        self.assertEqual(self.anchor.chain_status, "unchecked")

    def test_suppliers_and_anonymous_users_cannot_run_it(self):
        res = self.client.post(f"/api/projects/{self.project.pk}/verify-chain/")
        self.assertIn(res.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))
        self.client.force_authenticate(user=make_supplier().user)
        res = self.client.post(f"/api/projects/{self.project.pk}/verify-chain/")
        self.assertIn(res.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

    def test_without_chain_access_it_changes_nothing_and_says_so(self):
        self.client.force_authenticate(user=make_admin())
        with patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", ""):
            res = self.client.post(f"/api/projects/{self.project.pk}/verify-chain/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertTrue(res.data["detail"])
        self.anchor.refresh_from_db()
        self.assertEqual(self.anchor.chain_status, "unchecked")


class OnChainIdentityTests(APITestCase):
    """Stage 2: an anchor is only CONFIRMED on Sepolia, with an event our
    ledger emitted, that the contract's own storage (getAnchor) agrees with —
    and only then does it get an on-chain identity, depth and finality."""

    TX = "0x" + "ab" * 32
    LEDGER = "0x" + "12" * 20

    def setUp(self):
        patcher = patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.anchor = BlockchainAnchor.objects.create(
            entity_type="AWARD", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="4", stage="NOA_ISSUED",
            data_hash="0x" + "cd" * 32, tx_hash=self.TX, anchored_at=timezone.now())
        self.event = ledger_event(self.anchor, self.LEDGER, anchor_id=18, log_index=2)
        self.receipt = {"status": 1, "blockNumber": CHAIN_HEAD - 99, "to": self.LEDGER}

    def _confirm(self, w3=None, events=None, **node):
        w3 = w3 or sepolia_node(self.receipt, state={18: state_row(self.event)}, **node)
        with patch("procurement.blockchain.anchor_events",
                   return_value=[self.event] if events is None else events):
            outcome = confirm_anchor(self.anchor, w3=w3)
        self.anchor.refresh_from_db()
        return outcome

    def test_confirmation_stores_the_on_chain_identity_read_from_the_chain(self):
        self.assertEqual(self._confirm(), "confirmed")
        a = self.anchor
        self.assertEqual((a.chain_anchor_id, a.chain_log_index), (18, 2))
        self.assertEqual(int(a.chain_timestamp.timestamp()), self.event["timestamp"])
        self.assertEqual(a.chain_id, SEPOLIA)
        self.assertEqual(a.chain_contract.lower(), self.LEDGER)
        self.assertEqual(a.block_number, CHAIN_HEAD - 99)
        self.assertEqual(a.chain_confirmations, 100)
        self.assertTrue(a.chain_finalized)
        self.assertEqual(a.actor_address, self.event["actor"])        # the chain's signer
        summary = anchor_summary(a)
        self.assertEqual(summary["chain_anchor_id"], 18)
        self.assertTrue(summary["chain_finalized"])

    def test_a_node_on_another_network_confirms_nothing(self):
        for chain_id in (1, 17000, 31337):       # mainnet, Holesky, a local node
            with self.subTest(chain_id=chain_id):
                w3 = sepolia_node(self.receipt, state={18: state_row(self.event)}, chain_id=chain_id)
                self.assertEqual(self._confirm(w3), "wrong_network")
                w3.eth.get_transaction_receipt.assert_not_called()
                self.assertEqual(self.anchor.chain_status, "unchecked")
                self.assertIsNone(self.anchor.chain_anchor_id)
                self.assertEqual(self.anchor.tx_hash, self.TX)

    def test_a_chain_id_that_cannot_be_read_is_unknown_not_a_pass(self):
        w3 = sepolia_node(self.receipt, state={18: state_row(self.event)})
        type(w3.eth).chain_id = property(lambda _self: (_ for _ in ()).throw(ConnectionError("down")))
        self.assertEqual(self._confirm(w3), "unknown")
        self.assertEqual(self.anchor.chain_status, "unchecked")

    def test_contract_state_must_agree_with_the_event(self):
        honest = state_row(self.event)
        tampered = {
            "data hash": honest[:3] + ("0x" + "ee" * 32,) + honest[4:],
            "stage": honest[:2] + ("AWARDED",) + honest[3:],
            "signer": honest[:4] + ("0x" + "99" * 20, honest[5]),
            "timestamp": honest[:5] + (honest[5] + 1,),
        }
        for name, row in tampered.items():
            with self.subTest(name):
                w3 = sepolia_node(self.receipt, state={18: row})
                self.assertEqual(self._confirm(w3), "unknown")
                self.assertEqual(self.anchor.chain_status, "unchecked")
                self.assertIsNone(self.anchor.chain_anchor_id)

    def test_an_event_id_the_contract_does_not_know_is_not_confirmed(self):
        w3 = sepolia_node(self.receipt, state={})          # getAnchor(18) reverts
        self.assertEqual(self._confirm(w3), "unknown")
        self.assertFalse(self.anchor.verified_on_chain)

    def test_a_recent_block_is_confirmed_but_not_final_until_the_chain_says_so(self):
        self.assertEqual(self._confirm(finalized=CHAIN_HEAD - 150), "confirmed")
        self.assertEqual(self.anchor.chain_confirmations, 100)
        self.assertFalse(self.anchor.chain_finalized)
        # Still on the to-do list for the next pass...
        self.assertTrue(needs_chain_check().filter(pk=self.anchor.pk).exists())
        # ...which finds the block final once the finalized head passes it.
        self.assertEqual(self._confirm(finalized=CHAIN_HEAD - 10), "confirmed")
        self.assertTrue(self.anchor.chain_finalized)
        self.assertFalse(needs_chain_check().filter(pk=self.anchor.pk).exists())

    def test_finality_the_node_cannot_report_is_never_assumed(self):
        w3 = sepolia_node(self.receipt, state={18: state_row(self.event)})
        w3.eth.get_block.side_effect = ValueError("unknown block tag 'finalized'")
        self.assertEqual(self._confirm(w3), "confirmed")
        self.assertFalse(self.anchor.chain_finalized)
        self.assertEqual(self.anchor.chain_confirmations, 100)

    def test_without_the_latest_block_depth_is_unknown_and_not_final(self):
        w3 = sepolia_node(self.receipt, state={18: state_row(self.event)})
        type(w3.eth).block_number = property(lambda _self: (_ for _ in ()).throw(ConnectionError("down")))
        self.assertEqual(self._confirm(w3), "confirmed")
        self.assertIsNone(self.anchor.chain_confirmations)
        self.assertFalse(self.anchor.chain_finalized)

    def test_a_new_transaction_clears_the_previous_identity(self):
        self._confirm()
        attach_transaction(self.anchor, "0x" + "ef" * 32)
        self.anchor.refresh_from_db()
        for field in ("chain_anchor_id", "chain_log_index", "chain_timestamp", "chain_id",
                      "chain_confirmations"):
            self.assertIsNone(getattr(self.anchor, field), field)
        self.assertEqual(self.anchor.chain_contract, "")
        self.assertFalse(self.anchor.chain_finalized)

    def test_a_reverted_transaction_leaves_no_identity_behind(self):
        self.assertEqual(self._confirm(sepolia_node({"status": 0, "blockNumber": 5})), "reverted")
        self.assertIsNone(self.anchor.chain_anchor_id)
        self.assertFalse(self.anchor.anchored)

    def test_one_on_chain_record_can_back_only_one_anchor_row(self):
        from django.db import IntegrityError
        self._confirm()
        clone = dict(entity_type="AWARD", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="4", stage="NOA_ISSUED",
                     data_hash=self.anchor.data_hash, tx_hash=self.TX, chain_id=SEPOLIA,
                     chain_contract=self.anchor.chain_contract)
        with self.assertRaises(IntegrityError), transaction.atomic():
            BlockchainAnchor.objects.create(chain_anchor_id=18, **clone)
        # Unconfirmed rows (no on-chain id) are unconstrained, as before.
        BlockchainAnchor.objects.create(**clone)
        BlockchainAnchor.objects.create(**clone)

    def test_the_same_event_cannot_confirm_a_second_identical_row(self):
        self.assertEqual(self._confirm(), "confirmed")
        twin = BlockchainAnchor.objects.create(
            entity_type="AWARD", entity_ref="PC-AAAA-BBBB-CCCC", entity_id="4", stage="NOA_ISSUED",
            data_hash=self.anchor.data_hash, tx_hash=self.TX, anchored_at=timezone.now())
        w3 = sepolia_node(self.receipt, state={18: state_row(self.event)})
        with patch("procurement.blockchain.anchor_events", return_value=[self.event]):
            self.assertEqual(confirm_anchor(twin, w3=w3), "mismatch")
        twin.refresh_from_db()
        self.assertIsNone(twin.chain_anchor_id)
        self.assertFalse(twin.verified_on_chain)

    def test_the_command_refuses_to_run_against_the_wrong_network(self):
        w3 = sepolia_node(self.receipt, chain_id=1)
        out = io.StringIO()
        with patch("procurement.blockchain.web3_client", return_value=w3):
            call_command("confirm_anchors", "--apply", stdout=out)
        self.assertIn("expected 11155111", out.getvalue())
        w3.eth.get_transaction_receipt.assert_not_called()

    def test_the_command_reconciles_anchors_confirmed_before_identity_was_stored(self):
        BlockchainAnchor.objects.filter(pk=self.anchor.pk).update(
            chain_status=BlockchainAnchor.ChainStatus.CONFIRMED, block_number=CHAIN_HEAD - 99)
        w3 = sepolia_node(self.receipt, state={18: state_row(self.event)})
        with patch("procurement.blockchain.web3_client", return_value=w3), \
                patch("procurement.blockchain.anchor_events", return_value=[self.event]):
            call_command("confirm_anchors", "--apply", stdout=io.StringIO())
        self.anchor.refresh_from_db()
        self.assertEqual(self.anchor.chain_anchor_id, 18)

    def test_the_public_trail_exposes_only_public_on_chain_identity(self):
        project = make_project(status=Project.Status.PUBLISHED)
        BlockchainAnchor.objects.filter(pk=self.anchor.pk).update(entity_ref=project.code)
        self._confirm()
        res = self.client.get(f"/api/public/procurement/{project.code}/anchors/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        row = res.data["anchors"][0]
        self.assertEqual(row["chain_anchor_id"], 18)
        self.assertEqual(row["chain_id"], SEPOLIA)
        self.assertNotIn("payload", row)

    def test_the_server_fallback_read_refuses_another_network(self):
        w3 = sepolia_node(chain_id=1)
        with patch("procurement.blockchain.web3_client", return_value=w3):
            self.assertEqual(read_chain_anchors("PC-AAAA-BBBB-CCCC"), [])
        w3.eth.contract.assert_not_called()


class AnchorIdentityMigrationTests(TransactionTestCase):
    """0024 is additive: rows written before it keep every value and read as
    "no on-chain identity yet" — nothing is backfilled or guessed."""

    def test_existing_anchors_survive_the_migration_unchanged(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor

        before = [("procurement", "0023_evaluation_commitment")]
        after = [("procurement", "0024_anchor_onchain_identity")]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        old_apps = executor.loader.project_state(before).apps
        OldAnchor = old_apps.get_model("procurement", "BlockchainAnchor")
        old = OldAnchor.objects.create(
            entity_type="PROJECT", entity_ref="PRC-2026-976X-TVMX", stage="SUBMITTED",
            data_hash="0x" + "cd" * 32, tx_hash="0x" + "ab" * 32, block_number=8_000_000,
            chain_status="confirmed")

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(after)
        new = executor.loader.project_state(after).apps.get_model("procurement", "BlockchainAnchor")
        row = new.objects.get(pk=old.pk)
        self.assertEqual((row.tx_hash, row.block_number, row.chain_status),
                         ("0x" + "ab" * 32, 8_000_000, "confirmed"))
        self.assertIsNone(row.chain_anchor_id)
        self.assertIsNone(row.chain_timestamp)
        self.assertEqual(row.chain_contract, "")
        self.assertFalse(row.chain_finalized)
        # ...and it is queued for reconciliation, not treated as complete.
        self.assertTrue(needs_chain_check(BlockchainAnchor.objects.filter(pk=old.pk)).exists())


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


class SigningDisabledTests(APITestCase):
    """BLOCKCHAIN_WALLET_SIGNING=False (the local read-only demo): nothing can be
    written on-chain from this deployment. Turning off SERVER signing alone was
    not enough — "Anchor now" still opened MetaMask and the API still accepted
    the resulting tx hash. Now every write through /anchor/ is refused, even a
    hand-made request, and every anchor tells the browser not to offer one."""

    TX = "0x" + "ab" * 32

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.project = make_project(status=Project.Status.PENDING_HEAD)
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.anchor_id = res.data["anchor"]["id"]
        self.url = f"/api/projects/{self.project.pk}/anchor/"

    def _off(self):
        return patch("procurement.blockchain.WALLET_SIGNING_ENABLED", False)

    def _assert_untouched(self):
        anchor = BlockchainAnchor.objects.get(pk=self.anchor_id)
        self.assertEqual((anchor.tx_hash, anchor.anchored), ("", False))
        self.assertFalse(AuditLog.objects.filter(action="blockchain.anchored").exists())

    def test_a_metamask_tx_hash_is_refused(self):
        with self._off():
            res = self.client.post(self.url, {
                "anchor_id": self.anchor_id, "tx_hash": self.TX, "block_number": 1,
                "actor_address": "0x" + "11" * 20,
            }, format="json")
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(res.data["code"], "signing_disabled")
        self._assert_untouched()

    def test_a_stage_only_attach_is_refused_too(self):
        with self._off():
            res = self.client.post(self.url, {"stage": "HEAD_APPROVED", "tx_hash": self.TX}, format="json")
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        self._assert_untouched()

    def test_server_submit_is_refused_even_with_server_signing_on(self):
        with self._off(), patch("procurement.blockchain.SERVER_SIGNING_ENABLED", True), \
                patch("procurement.blockchain.submit_anchor_server_side") as submit:
            res = self.client.post(self.url, {"anchor_id": self.anchor_id, "server_submit": True}, format="json")
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        submit.assert_not_called()
        self._assert_untouched()

    def test_role_checks_still_come_first(self):
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        with self._off():
            res = self.client.post(self.url, {"anchor_id": self.anchor_id, "tx_hash": self.TX}, format="json")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)
        self._assert_untouched()

    def test_transitions_still_work_and_never_sign_automatically(self):
        # The business flow is never blocked; the anchor is computed and stored,
        # just never sent — not even by the server's own automatic signing.
        project = make_project(status=Project.Status.PENDING_HEAD)
        with self._off(), patch("procurement.blockchain.SERVER_SIGNING_ENABLED", True), \
                patch("procurement.blockchain.submit_anchor_server_side") as submit:
            res = self.client.post(f"/api/projects/{project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        submit.assert_not_called()
        self.assertFalse(res.data["anchor"]["signing_enabled"])
        self.assertFalse(res.data["anchor"]["server_signing"])
        self.assertEqual(BlockchainAnchor.objects.get(pk=res.data["anchor"]["id"]).tx_hash, "")

    def test_server_side_submit_is_a_no_op(self):
        anchor = BlockchainAnchor.objects.get(pk=self.anchor_id)
        with self._off(), patch("procurement.blockchain.SERVER_SIGNING_ENABLED", True), \
                patch("procurement.blockchain.BLOCKCHAIN_PRIVATE_KEY", "0x" + "22" * 32), \
                patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", "0x" + "33" * 20), \
                patch("procurement.blockchain._load_web3") as load_web3:
            self.assertIsNone(submit_anchor_server_side(anchor))
        load_web3.assert_not_called()

    def test_every_anchor_tells_the_browser(self):
        anchor = BlockchainAnchor.objects.get(pk=self.anchor_id)
        with self._off():
            self.assertFalse(anchor_summary(anchor)["signing_enabled"])
            record = self.client.get(f"/api/projects/{self.project.pk}/anchors/")
        self.assertEqual(record.status_code, status.HTTP_200_OK)
        rows = record.data if isinstance(record.data, list) else record.data.get("anchors", [])
        self.assertTrue(rows)
        self.assertTrue(all(row["signing_enabled"] is False for row in rows))

    def test_production_default_is_unchanged(self):
        # Unset → signing allowed; only an explicit False turns it off.
        import os
        from .blockchain import _env_flag
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BLOCKCHAIN_WALLET_SIGNING", None)
            self.assertTrue(_env_flag("BLOCKCHAIN_WALLET_SIGNING", "True"))
        for value, expected in (("True", True), ("true", True), ("False", False), ("false", False), ("0", False)):
            with patch.dict(os.environ, {"BLOCKCHAIN_WALLET_SIGNING": value}):
                self.assertIs(_env_flag("BLOCKCHAIN_WALLET_SIGNING", "True"), expected, value)
        # ...and attach works exactly as before.
        with patch("procurement.blockchain.WALLET_SIGNING_ENABLED", True):
            anchor = BlockchainAnchor.objects.get(pk=self.anchor_id)
            self.assertTrue(anchor_summary(anchor)["signing_enabled"])
            res = self.client.post(self.url, {"anchor_id": self.anchor_id, "tx_hash": self.TX}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(BlockchainAnchor.objects.get(pk=self.anchor_id).tx_hash, self.TX)


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
        # Stored under a random name — nothing of the uploaded filename, and no
        # bid id, survives in the path.
        self.assertRegex(image.image.name, r"^bid_documents/product_images/[0-9a-f]{32}\.png$")
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
                # Release the file handle so tearDown can delete it on Windows.
                # res.close() fires request_finished, whose close_old_connections
                # handler would close the test's DB connection — harmless on
                # SQLite, fatal for every later test on PostgreSQL — so it is
                # detached for the close, exactly as Django's test client does.
                request_finished.disconnect(close_old_connections)
                try:
                    res.close()
                finally:
                    request_finished.connect(close_old_connections)
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
        self.assertEqual({a.stage for a in anchors}, {"EVALUATION_COMPLETED", "BID_SUBMITTED", "AWARDED"})
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
        self.assertFalse(res.data["awards"][0]["verified_on_chain"])

    def test_public_summary_exposes_no_private_fields(self):
        res = self.client.get("/api/public/summary/")
        body = json.dumps(res.data, default=str)
        # No bid amounts at all: not the losers', and not the contract amount
        # either (decision D2: the public sees the winner only).
        self.assertNotIn("48765", body)
        self.assertNotIn("47321", body)
        self.assertNotIn("45000", body)
        for private in ("contact", "email", "Jane Dela Cruz", "tin", "phone", "documents",
                        "payload", "data_hash", "reference_image", "supplier_id"):
            self.assertNotIn(private, body)
        self.assertEqual(set(res.data["awards"][0]),
                         {"code", "name", "category", "winner", "awarded_at", "verified_on_chain", "explorer_url"})
        self.assertEqual(set(res.data["open"][0]),
                         {"code", "name", "category", "budget", "deadline", "published_at", "bids"})


class EvaluationCommitmentTests(APITestCase):
    """EVALUATION_COMPLETED: one salted commitment, written at award time, to
    every bid received and its final outcome. Proves the evaluation was fixed
    when the award was made, without putting any losing amount on-chain."""

    def setUp(self):
        cache.clear()
        self._media = tempfile.mkdtemp()
        self._override = override_settings(MEDIA_ROOT=self._media)
        self._override.enable()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.winner_supplier = make_supplier()
        self.loser_supplier = make_supplier()
        self.third_supplier = make_supplier()
        self.win = Bid.objects.create(project=self.project, supplier=self.winner_supplier, amount=41111,
                                      status=Bid.Status.QUALIFIED, quotation_document=dummy_pdf("q1.pdf"))
        self.lose = Bid.objects.create(project=self.project, supplier=self.loser_supplier, amount=43333,
                                       status=Bid.Status.QUALIFIED, quotation_document=dummy_pdf("q2.pdf"))
        self.dq = Bid.objects.create(project=self.project, supplier=self.third_supplier, amount=39999,
                                     status=Bid.Status.DISQUALIFIED, quotation_document=dummy_pdf("q3.pdf"))
        self.client.force_authenticate(user=self.admin)
        self.res = self.client.post(f"/api/bids/{self.win.pk}/select-winner/")
        self.anchor = BlockchainAnchor.objects.get(stage=BlockchainAnchor.Stage.EVALUATION_COMPLETED)

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self._media, ignore_errors=True)

    def test_awarding_signs_evaluation_then_winning_bid_then_award(self):
        self.assertEqual(self.res.status_code, status.HTTP_200_OK, self.res.data)
        self.assertEqual([a["stage"] for a in self.res.data["anchor_sequence"]],
                         ["EVALUATION_COMPLETED", "BID_SUBMITTED", "AWARDED"])

    def test_commitment_covers_every_bid_but_reveals_no_amount_or_supplier(self):
        payload = self.anchor.payload
        self.assertEqual(payload["bid_count"], 3)
        self.assertEqual(len(payload["leaves"]), 3)
        self.assertEqual(set(payload), {"v", "entity", "stage", "code", "bid_count", "leaves"})
        body = json.dumps(payload)
        for secret in ("41111", "43333", "39999", "winner", "disqualified"):
            self.assertNotIn(secret, body)
        for bid in Bid.objects.filter(project=self.project):
            self.assertEqual(len(bid.commitment_salt), 64)
            self.assertTrue(bid.committed_document_hash.startswith("0x"))
        self.assertEqual(self.anchor.document_hash, "")

    def test_the_salt_is_what_makes_a_leaf_unguessable(self):
        bid = Bid.objects.get(pk=self.lose.pk)
        unsalted = dict(bid_leaf_fields(bid), salt="")
        self.assertNotEqual(hash_payload(unsalted), bid_leaf(bid))
        self.assertIn(bid_leaf(bid), self.anchor.payload["leaves"])

    def test_an_honest_record_verifies(self):
        self.assertEqual(verify_anchor(self.anchor, deep=True)["status"], "match")

    def test_repricing_regrading_adding_or_dropping_a_bid_is_detected(self):
        changes = {
            "re-priced losing bid": lambda: Bid.objects.filter(pk=self.lose.pk).update(amount=40000),
            "re-graded bid": lambda: Bid.objects.filter(pk=self.dq.pk).update(status=Bid.Status.QUALIFIED),
            "dropped bid": lambda: Bid.objects.filter(pk=self.dq.pk).delete(),
            "added bid": lambda: Bid.objects.create(project=self.project, supplier=make_supplier(), amount=1),
        }
        for name, change in changes.items():
            with self.subTest(name):
                sid = transaction.savepoint()
                change()
                self.assertEqual(verify_anchor(self.anchor)["status"], "mismatch", name)
                transaction.savepoint_rollback(sid)
        self.assertEqual(verify_anchor(self.anchor)["status"], "match")

    def test_a_replaced_losing_quotation_is_caught_by_the_deep_check(self):
        bid = Bid.objects.get(pk=self.lose.pk)
        bid.quotation_document.save("swapped.pdf", ContentFile(b"%PDF-1.4 a different offer"))
        self.assertEqual(verify_anchor(self.anchor)["status"], "match")          # record unchanged
        deep = verify_anchor(self.anchor, deep=True)
        self.assertEqual(deep["document"], "mismatch")
        self.assertEqual(deep["status"], "mismatch")

    def test_evaluation_is_final_after_award(self):
        for action in ("qualify", "disqualify"):
            res = self.client.post(f"/api/bids/{self.dq.pk}/{action}/")
            self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST, action)
        self.dq.refresh_from_db()
        self.assertEqual(self.dq.status, Bid.Status.DISQUALIFIED)
        self.assertEqual(verify_anchor(self.anchor)["status"], "match")

    def test_commitments_are_never_rewritten(self):
        bid = Bid.objects.get(pk=self.lose.pk)
        salt = bid.commitment_salt
        _commit_bids([bid])
        bid.refresh_from_db()
        self.assertEqual(bid.commitment_salt, salt)

    def test_inclusion_receipt_lets_a_bidder_check_their_own_bid(self):
        receipt = inclusion_receipt(Bid.objects.get(pk=self.lose.pk))
        self.assertEqual(hash_payload(receipt["leaf_fields"]), receipt["leaf"])
        self.assertIn(receipt["leaf"], receipt["payload"]["leaves"])
        self.assertEqual(hash_payload(receipt["payload"]), receipt["anchor"]["data_hash"])
        # Only their OWN amount is in it; the other leaves are opaque.
        body = json.dumps(receipt, default=str)
        self.assertIn("43333", body)
        self.assertNotIn("41111", body)
        self.assertNotIn("39999", body)

    def test_public_trail_shows_only_the_hash(self):
        self.client.force_authenticate(user=None)
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        row = next(a for a in res.data["anchors"] if a["stage"] == "EVALUATION_COMPLETED")
        self.assertEqual(row["data_hash"], self.anchor.data_hash)
        self.assertEqual(row["integrity"]["status"], "match")
        body = json.dumps(res.data, default=str)
        salt = Bid.objects.get(pk=self.win.pk).commitment_salt
        for secret in ("41111", "43333", "39999", "leaves", "salt", salt):
            self.assertNotIn(secret, body)


class PayloadHashVectorTests(APITestCase):
    """contracts/payload-hash-vectors.json is shared with the browser tests
    (frontend/src/blockchain/packetVerify.test.js): both hashers must produce
    these exact values, or a verifier's browser would reject honest records."""

    def test_the_backend_reproduces_every_shared_vector(self):
        from pathlib import Path
        from django.conf import settings
        path = Path(settings.BASE_DIR).parent / "contracts" / "payload-hash-vectors.json"
        vectors = json.loads(path.read_text(encoding="utf-8"))["vectors"]
        self.assertGreaterEqual(len(vectors), 6)
        for v in vectors:
            with self.subTest(v["name"]):
                self.assertEqual(hash_payload(v["payload"]), v["data_hash"])


class VerificationPacketContentTests(APITestCase):
    """A packet serves the payload EXACTLY as stored at anchoring time — never
    rebuilt from the live record, never re-serialized — and says plainly when
    that payload can't support an independent check."""

    def setUp(self):
        from .packets import build_packet
        self.build_packet = build_packet
        self.project = make_project(status=Project.Status.PUBLISHED)

    def _anchor(self, payload, **fields):
        return BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
            stage=fields.pop("stage", "SUBMITTED"),
            data_hash=fields.pop("data_hash", hash_payload(payload) if payload else "0x" + "00" * 32),
            payload=payload, **fields)

    def test_a_legacy_v1_payload_is_served_as_stored_not_rebuilt(self):
        v1 = {"v": 1, "entity": "PROJECT", "stage": "SUBMITTED", "code": self.project.code,
              "name": "Old name, since edited", "category": "", "type": "", "budget": "1.00",
              "status": "pending_head", "deadline": "", "reviewed_at": "", "published_at": "",
              "created_at": "2026-07-27T14:10:00+00:00", "document_hash": ""}
        anchor = self._anchor(v1)
        packet = self.build_packet(anchor)
        self.assertEqual(packet["payload"], v1)
        self.assertEqual(packet["payload_version"], 1)
        self.assertTrue(packet["server_check"]["payload_reproduces_data_hash"])
        self.assertTrue(any("Legacy (v1)" in x for x in packet["limitations"]))
        # The public route serves it too: every v1 project key is public.
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/{anchor.pk}/packet/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["payload"], v1)

    def test_a_missing_payload_is_reported_not_invented(self):
        packet = self.build_packet(self._anchor({}))
        self.assertIsNone(packet["payload"])
        self.assertFalse(packet["server_check"]["payload_reproduces_data_hash"])
        self.assertTrue(any("was not stored" in x for x in packet["limitations"]))

    def test_a_payload_that_no_longer_reproduces_its_hash_is_flagged_not_fixed(self):
        good = {"v": 2, "entity": "PROJECT", "stage": "SUBMITTED", "code": self.project.code,
                "name": "x", "document_hash": ""}
        anchor = self._anchor(good)
        BlockchainAnchor.objects.filter(pk=anchor.pk).update(payload={**good, "name": "edited"})
        anchor.refresh_from_db()
        packet = self.build_packet(anchor)
        self.assertEqual(packet["payload"]["name"], "edited")             # as stored
        self.assertEqual(packet["data_hash"], hash_payload(good))         # as recorded
        self.assertFalse(packet["server_check"]["payload_reproduces_data_hash"])
        self.assertTrue(any("does not reproduce" in x for x in packet["limitations"]))

    def test_the_packet_carries_the_on_chain_identity_and_honest_gaps(self):
        payload = {"v": 2, "entity": "PROJECT", "stage": "SUBMITTED", "code": self.project.code,
                   "name": "x", "document_hash": "0x" + "ab" * 32}
        unlinked = self.build_packet(self._anchor(payload, tx_hash="0x" + "cd" * 32))
        self.assertIsNone(unlinked["recorded"]["chain_anchor_id"])
        self.assertTrue(any("find it by searching" in x for x in unlinked["limitations"]))
        linked = self.build_packet(self._anchor(
            {**payload, "stage": "HEAD_APPROVED"}, stage="HEAD_APPROVED", tx_hash="0x" + "cd" * 32, chain_anchor_id=18, chain_id=11155111,
            chain_contract="0x" + "12" * 20, chain_finalized=True))
        self.assertEqual(linked["recorded"]["chain_anchor_id"], 18)
        self.assertEqual(linked["document_hash"], "0x" + "ab" * 32)
        self.assertFalse(any("searching" in x for x in linked["limitations"]))
        self.assertTrue(linked["server_check"]["payload_reproduces_data_hash"])


class AwardDocumentVersionTests(APITestCase):
    """Re-issuing a post-award document must not lose the earlier issue: every
    issue keeps its exact stored bytes, hash, issue date and anchor
    (AwardDocumentVersion), downloadable under the award-document rules."""

    def setUp(self):
        import hashlib
        self.sha = lambda data: "0x" + hashlib.sha256(data).hexdigest()
        cache.clear()
        self._media = tempfile.mkdtemp()
        override = override_settings(MEDIA_ROOT=self._media)
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, self._media, ignore_errors=True)
        self.admin, self.head = make_admin(), make_head()
        self.winner, self.loser = make_supplier(), make_supplier()
        self.project = make_project(status=Project.Status.PUBLISHED)
        win = Bid.objects.create(project=self.project, supplier=self.winner, amount=50000, status=Bid.Status.QUALIFIED)
        Bid.objects.create(project=self.project, supplier=self.loser, amount=60000, status=Bid.Status.QUALIFIED)
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/bids/{win.pk}/select-winner/").status_code, 200)
        self.award = Award.objects.get()
        # Issue 1: generated draft. Issue 2: the signed scan replaces it.
        self.assertEqual(self.client.post(f"/api/awards/{self.award.pk}/documents/generate/",
                                          {"key": "notice_of_award"}, format="json").status_code, 200)
        signed = SimpleUploadedFile("signed-noa.pdf", b"%PDF-1.4 signed notice", content_type="application/pdf")
        res = self.client.post(f"/api/awards/{self.award.pk}/documents/",
                               {"key": "notice_of_award", "file": signed}, format="multipart")
        self.assertEqual(res.status_code, 200, res.data)
        self.client.force_authenticate(user=None)
        self.v1, self.v2 = AwardDocumentVersion.objects.filter(award=self.award, key="notice_of_award")

    def _bytes(self, version):
        version.file.open("rb")
        try:
            return version.file.read()
        finally:
            version.file.close()

    def test_each_issue_keeps_its_own_bytes_hash_date_and_anchor(self):
        self.assertEqual((self.v1.version, self.v2.version), (1, 2))
        self.assertTrue(self.v1.generated)
        self.assertFalse(self.v2.generated)
        self.assertEqual(self.v2.original_filename, "signed-noa.pdf")
        self.assertNotEqual(self.v1.file.name, self.v2.file.name)
        for v in (self.v1, self.v2):
            self.assertEqual(self.sha(self._bytes(v)), v.document_hash)      # exact stored bytes
            self.assertEqual(v.anchor.document_hash, v.document_hash)          # the anchored hash
            self.assertEqual(v.anchor.payload["issued_at"], v.issued_at.isoformat())
        self.award.refresh_from_db()
        self.assertEqual(self.award.notice_of_award.name, self.v2.file.name)  # current = latest
        self.assertEqual(self._bytes(self.v2), b"%PDF-1.4 signed notice")

    def test_an_earlier_issue_downloads_under_the_award_document_rules(self):
        url = f"/api/files/awardversion/{self.v1.pk}/file/"
        for user, expected in ((self.admin, 200), (self.head, 200), (self.winner.user, 200),
                               (self.loser.user, 404)):
            self.client.force_authenticate(user=user)
            res = self.client.get(url)
            self.assertEqual(res.status_code, expected, getattr(user, "username", user))
            if expected == 200:
                body = b"".join(res.streaming_content)
                self.assertEqual(self.sha(body), self.v1.document_hash)
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(url).status_code, 404)         # never public

    def test_the_version_list_marks_current_and_superseded_issues(self):
        from .document_versions import versions_for
        files = lambda kind, record, field: (f"{kind}/{record.pk}/{field}", "x.pdf")  # noqa: E731
        versions = versions_for(self.v1.anchor, file_for=files)
        self.assertEqual([(v["number"], v["total"], v["current"]) for v in versions], [(1, 2, False), (2, 2, True)])
        self.assertEqual([v["anchor_id"] for v in versions], [self.v1.anchor_id, self.v2.anchor_id])
        self.assertEqual(versions[0]["file_url"], f"awardversion/{self.v1.pk}/file")
        self.assertTrue(all(v["preserved"] and v["fingerprinted"] for v in versions))

    def test_issues_from_before_version_history_are_listed_but_never_invented(self):
        from .document_versions import versions_for
        files = lambda kind, record, field: (f"{kind}/{record.pk}/{field}", None)  # noqa: E731
        AwardDocumentVersion.objects.all().delete()       # as if issued before this table existed
        old, new = versions_for(self.v1.anchor, file_for=files)
        self.assertFalse(old["preserved"])
        self.assertIsNone(old["file_url"])
        self.assertIn("not preserved", old["file_note"])
        self.assertEqual(old["document_hash"], BlockchainAnchor.objects.get(pk=old["anchor_id"]).document_hash)
        # The newest issue falls back to the award's current file, because its
        # issue date still equals the one the anchor hashed...
        self.assertEqual(new["file_url"], f"award/{self.award.pk}/notice_of_award")
        # ...and stops doing so once that date no longer matches.
        Award.objects.filter(pk=self.award.pk).update(noa_issued_at=timezone.now() + timedelta(days=1))
        _, new = versions_for(self.v1.anchor, file_for=files)
        self.assertIsNone(new["file_url"])
        self.assertIn("no longer belongs", new["file_note"])

    def test_an_issue_is_kept_even_when_anchoring_is_off(self):
        self.client.force_authenticate(user=self.admin)
        with patch("procurement.blockchain.ANCHORING_ENABLED", False):
            res = self.client.post(f"/api/awards/{self.award.pk}/documents/generate/",
                                   {"key": "notice_to_proceed"}, format="json")
        self.assertEqual(res.status_code, 200)
        v = AwardDocumentVersion.objects.get(award=self.award, key="notice_to_proceed")
        self.assertIsNone(v.anchor)
        self.assertEqual(self.sha(self._bytes(v)), v.document_hash)

    def test_history_keeping_never_breaks_an_issue(self):
        self.client.force_authenticate(user=self.admin)
        with patch("procurement.document_versions.AwardDocumentVersion.objects.create",
                   side_effect=RuntimeError("db down")):
            res = self.client.post(f"/api/awards/{self.award.pk}/documents/generate/",
                                   {"key": "award_resolution"}, format="json")
        self.assertEqual(res.status_code, 200)
        self.award.refresh_from_db()
        self.assertTrue(self.award.award_resolution)

    def test_a_missing_file_is_reported_as_missing_not_as_forbidden(self):
        from .document_versions import versions_for
        files = lambda kind, record, field: (f"{kind}/{record.pk}/{field}", None)  # noqa: E731
        AwardDocumentVersion.objects.all().delete()
        Award.objects.filter(pk=self.award.pk).update(notice_of_award="")
        *_, new = versions_for(self.v1.anchor, file_for=files)
        self.assertIsNone(new["file_url"])
        self.assertEqual(new["file_note"], "No file is stored for this document.")


class ConfirmedSignerTests(APITestCase):
    """The signer shown for a confirmed record is the one the chain recorded,
    not whatever address the browser posted with its tx hash."""

    LEDGER = "0x" + "12" * 20

    def test_confirmation_replaces_a_reported_signer_with_the_on_chain_one(self):
        anchor = BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref="PC-AAAA-BBBB-CCCC", stage="SUBMITTED",
            data_hash="0x" + "cd" * 32, tx_hash="0x" + "ab" * 32, actor_address="0x" + "99" * 20,
            anchored_at=timezone.now())
        ev = ledger_event(anchor, self.LEDGER, actor="0x" + "77" * 20)
        w3 = sepolia_node({"status": 1, "blockNumber": CHAIN_HEAD - 5}, state={ev["id"]: state_row(ev)})
        with patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER),                 patch("procurement.blockchain.anchor_events", return_value=[ev]):
            self.assertEqual(confirm_anchor(anchor, w3=w3), "confirmed")
        anchor.refresh_from_db()
        self.assertEqual(anchor.actor_address, "0x" + "77" * 20)


# ── Stage 5 Phase 2: v3 encoding, the five-document manifest, version history ──

def shared_vectors():
    from pathlib import Path
    from django.conf import settings
    path = Path(settings.BASE_DIR).parent / "contracts" / "payload-hash-vectors.json"
    return json.loads(path.read_text(encoding="utf-8"))["vectors"]


def v3_vectors():
    return [v for v in shared_vectors() if v["payload"].get("kind") == "project-stage/3"]


def vector_named(prefix):
    return next(v for v in shared_vectors() if v["name"].startswith(prefix))


def document_pdf(body, name="doc.pdf"):
    return SimpleUploadedFile(name, b"%PDF-1.4 " + body, content_type="application/pdf")


class CanonicalValidatorTests(APITestCase):
    def test_objects_strings_and_integers_pass(self):
        validate_canonical({"a": "Pañuelo 🚀", "n": 2 ** 53 - 1, "z_1": 0, "o": {"b": ""}})

    def test_everything_else_is_refused(self):
        for bad in (None, True, False, 1.5, [], [1], (1,), {1, 2}, 2 ** 53, -1, b"x", timezone.now()):
            with self.subTest(repr(bad)):
                with self.assertRaises(NonCanonicalPayload):
                    validate_canonical({"outer": {"inner": bad}})

    def test_keys_must_be_lowercase_ascii_names(self):
        for key in (1, None, "ñ", "Upper", "with-dash", "with space", ""):
            with self.subTest(repr(key)):
                with self.assertRaises(NonCanonicalPayload):
                    validate_canonical({key: "x"})

    def test_hash_payload_itself_stays_lenient_for_the_anchors_it_already_hashed(self):
        self.assertTrue(hash_payload({"n": 1.5, "x": None, "l": [1]}).startswith("0x"))


class ProjectStagePayloadV3Tests(APITestCase):
    def _valid(self):
        return json.loads(json.dumps(v3_vectors()[0]["payload"]))

    def test_the_shared_file_has_v3_cases_and_each_passes_the_schema(self):
        vectors = v3_vectors()
        self.assertGreaterEqual(len(vectors), 4)
        self.assertTrue(any(ord(c) > 127 for v in vectors for c in v["payload"]["name"]))
        for v in vectors:
            with self.subTest(v["name"]):
                payload_v3.validate_project_stage(v["payload"])
                self.assertEqual(hash_payload(v["payload"]), v["data_hash"])

    def test_the_builder_produces_the_first_vector_exactly(self):
        from datetime import datetime
        from decimal import Decimal
        from types import SimpleNamespace
        from zoneinfo import ZoneInfo
        vector = v3_vectors()[0]
        expected = vector["payload"]
        # Stored in Manila time on purpose: the payload's text must still be UTC.
        created = datetime(2026, 11, 3, 16, 15, 0, 123456, tzinfo=ZoneInfo("Asia/Manila"))
        project = SimpleNamespace(
            code=expected["code"], name=expected["name"], category=expected["category"], type=expected["type"],
            budget=Decimal(expected["budget"]), bidding_period_days=expected["bidding_period_days"],
            delivery_period_days=expected["delivery_period_days"], created_at=created)
        built = payload_v3.project_payload(project, expected["stage"], expected["documents"])
        self.assertEqual(built, expected)
        self.assertEqual(hash_payload(built), vector["data_hash"])

    def test_reordered_fields_and_manifest_entries_hash_the_same(self):
        """Section 7: 24 insertion orders, one data_hash. The browser side is in
        packetVerify.test.js."""
        from itertools import islice, permutations
        for vector in v3_vectors():
            payload = vector["payload"]
            top = list(payload)
            orders = list(islice(permutations(payload["documents"]), 24))
            self.assertEqual(len(orders), 24)
            for i, order in enumerate(orders):
                keys = top[i % len(top):] + top[:i % len(top)]
                shuffled = {key: payload[key] for key in reversed(keys)}
                shuffled["documents"] = {
                    k: dict(reversed(list(payload["documents"][k].items()))) for k in order
                }
                self.assertEqual(hash_payload(shuffled), vector["data_hash"])

    def test_a_different_kind_tag_gives_a_different_hash_and_is_refused(self):
        valid = self._valid()
        other = {**valid, "kind": payload_v3.KIND_AWARD_PRIVATE}
        self.assertNotEqual(hash_payload(valid), hash_payload(other))
        with self.assertRaises(NonCanonicalPayload):
            payload_v3.validate_project_stage(other)

    def test_anything_outside_the_schema_is_refused(self):
        def top(**changes):
            return lambda p: p.update(changes)

        def entry(key="terms_of_reference", **changes):
            return lambda p: p["documents"][key].update(changes)

        def drop(key):
            return lambda p: p.pop(key)

        evidence = "purchase_request"     # the first vector is SUBMITTED
        cases = {
            "extra field": top(status="approved"),
            "missing field": drop("category"),
            "wrong version": top(v=2),
            "version as a boolean": top(v=True),
            "wrong kind": top(kind="evaluation/3"),
            "wrong entity": top(entity="BID"),
            "not a project stage": top(stage="AWARDED"),
            "empty code": top(code=""),
            "null name": top(name=None),
            "budget as a number": top(budget=250000),
            "budget with one decimal": top(budget="250000.5"),
            "budget with a comma": top(budget="250,000.00"),
            "local time": top(created_at="2026-11-03T16:15:00+08:00"),
            "date only": top(created_at="2026-11-03"),
            "period as a boolean": top(bidding_period_days=True),
            "negative period": top(delivery_period_days=-1),
            "an array": top(documents=[]),
            "evidence key of another stage": top(document_key="terms_of_reference"),
            "evidence hash differs from the manifest": top(document_hash="0x" + "f" * 64),
            "manifest entry missing": lambda p: p["documents"].pop("terms_of_reference"),
            "manifest entry extra": lambda p: p["documents"].update(
                reference_image={"state": "absent", "sha256": "", "version": 0}),
            "entry with an extra key": entry(file_name="tor.pdf"),
            "entry key missing": lambda p: p["documents"]["terms_of_reference"].pop("version"),
            "unknown state": entry(state="missing"),
            "uppercase hash": entry(sha256="0x" + "A" * 64),
            "hash without 0x": entry(sha256="a" * 64),
            "present without a hash": entry(sha256=""),
            "present at version 0": entry(version=0),
            "absent with a hash": entry(state="absent", version=0),
            "absent with a version": entry(state="absent", sha256="", version=1),
            "unreadable with a hash": entry(state="unreadable"),
            "unreadable at version 0": entry(state="unreadable", sha256="", version=0),
            "version as a string": entry(version="1"),
        }
        self.assertEqual(self._valid()["document_key"], evidence)
        for name, change in cases.items():
            with self.subTest(name):
                payload = self._valid()
                change(payload)
                with self.assertRaises(NonCanonicalPayload):
                    payload_v3.validate_project_stage(payload)


class ProjectDocumentCase(APITestCase):
    """A temporary media root, plus filing and revising through the real API."""

    def setUp(self):
        cache.clear()
        media = tempfile.mkdtemp()
        override = override_settings(MEDIA_ROOT=media)
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        self.admin, self.head = make_admin(), make_head()

    def file_project(self, purchase_request=b"pr one"):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post("/api/projects/", {
            "name": "Laptops", "type": "Goods", "category": "IT Equipment", "delivery_location": "HQ",
            "budget": "1000", "bidding_period_days": 10, "delivery_period_days": 30,
            "purchase_request": document_pdf(purchase_request, "my-pr.pdf"),
            "technical_specifications": document_pdf(b"specs"), "terms_of_reference": document_pdf(b"tor"),
            "approved_budget_document": document_pdf(b"abc"), "bid_evaluation_criteria": document_pdf(b"criteria"),
        }, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        return Project.objects.get(pk=res.data["id"])

    def revise(self, project, body, key="purchase_request", expect=status.HTTP_200_OK):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(f"/api/projects/{project.pk}/request-revision/",
                               {"documents": {key: "please fix"}}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/projects/{project.pk}/resubmit-documents/",
                               {key: document_pdf(body, "revised.pdf")}, format="multipart")
        self.assertEqual(res.status_code, expect, res.data)
        project.refresh_from_db()

    def versions(self, project, key="purchase_request"):
        return list(ProjectDocumentVersion.objects.filter(project=project, key=key).order_by("version"))

    @staticmethod
    def stored_bytes(row):
        row.file.open("rb")
        try:
            return row.file.read()
        finally:
            row.file.close()

    def legacy_project(self, **files):
        """A project filed before version history existed: files, no rows."""
        project = make_project(status=Project.Status.PENDING_HEAD)
        for key, body in files.items():
            setattr(project, key, document_pdf(body))
        project.save()
        return project


class ProjectDocumentVersionTests(ProjectDocumentCase):
    def test_filing_records_version_one_of_all_five_documents(self):
        project = self.file_project()
        rows = ProjectDocumentVersion.objects.filter(project=project)
        self.assertEqual(sorted(r.key for r in rows), sorted(PROCUREMENT_DOCUMENT_KEYS))
        for row in rows:
            self.assertEqual(row.version, 1)
            self.assertEqual(row.project_code, project.code)
            self.assertEqual(row.uploaded_by, self.admin)
            self.assertEqual(row.file.name, getattr(project, row.key).name)
            self.assertEqual(row.sha256, hash_file(getattr(project, row.key)))
            self.assertIsNotNone(row.recorded_at)
        self.assertEqual(self.versions(project)[0].original_filename, "my-pr.pdf")

    def test_the_same_bytes_uploaded_three_times_is_one_version(self):
        project = self.file_project(b"same")
        self.revise(project, b"same")
        self.revise(project, b"same")
        rows = self.versions(project)
        self.assertEqual([r.version for r in rows], [1])
        manifest = blockchain.document_manifest(project)
        self.assertEqual(manifest["purchase_request"]["version"], 1)
        self.assertEqual(manifest["purchase_request"]["sha256"], rows[0].sha256)

    def test_different_bytes_are_a_new_version_and_the_old_file_is_kept(self):
        project = self.file_project(b"first")
        first_name = project.purchase_request.name
        self.revise(project, b"second")
        first, second = self.versions(project)
        self.assertEqual((first.version, second.version), (1, 2))
        self.assertEqual(first.file.name, first_name)
        self.assertNotEqual(second.file.name, first_name)
        self.assertEqual(self.stored_bytes(first), b"%PDF-1.4 first")
        self.assertEqual(self.stored_bytes(second), b"%PDF-1.4 second")
        self.assertEqual(second.sha256, hash_file(project.purchase_request))
        self.assertEqual(second.original_filename, "revised.pdf")
        # Only the replaced document moved.
        self.assertEqual([r.version for r in self.versions(project, "terms_of_reference")], [1])

    def test_going_back_to_earlier_bytes_is_a_new_version(self):
        project = self.file_project(b"A")
        self.revise(project, b"B")
        self.revise(project, b"A")
        rows = self.versions(project)
        self.assertEqual([r.version for r in rows], [1, 2, 3])
        self.assertEqual(rows[0].sha256, rows[2].sha256)
        self.assertNotEqual(rows[0].sha256, rows[1].sha256)

    def test_history_starts_from_the_file_on_record_and_nothing_is_invented(self):
        project = self.legacy_project(purchase_request=b"older", terms_of_reference=b"tor")
        older_name = project.purchase_request.name
        self.assertFalse(ProjectDocumentVersion.objects.filter(project=project).exists())
        self.revise(project, b"newer")
        baseline, replacement = self.versions(project)
        self.assertEqual((baseline.version, baseline.file.name), (1, older_name))
        self.assertIsNone(baseline.uploaded_by)     # unknown, so not guessed
        self.assertEqual(self.stored_bytes(baseline), b"%PDF-1.4 older")
        self.assertEqual((replacement.version, replacement.uploaded_by), (2, self.admin))
        # Documents nobody touched get no row, and no document gains a made-up one.
        self.assertEqual(self.versions(project, "terms_of_reference"), [])
        self.assertEqual(ProjectDocumentVersion.objects.filter(project=project).count(), 2)

    def test_absent_and_unreadable_stay_different_things(self):
        from .project_documents import document_state
        project = self.legacy_project(purchase_request=b"pr")
        self.assertEqual(document_state(project.terms_of_reference), ("absent", ""))
        state, sha = document_state(project.purchase_request)
        self.assertEqual((state, sha), ("present", hash_file(project.purchase_request)))
        with patch("django.db.models.fields.files.FieldFile.open", side_effect=OSError("storage down")):
            self.assertEqual(document_state(project.purchase_request), ("unreadable", ""))
        project.purchase_request.storage.delete(project.purchase_request.name)
        self.assertEqual(document_state(project.purchase_request), ("unreadable", ""))

    def test_the_hash_is_of_what_storage_holds_not_what_the_field_has_in_memory(self):
        from .project_documents import document_state
        project = self.legacy_project(purchase_request=b"stored")
        expected = "0x" + hashlib.sha256(b"%PDF-1.4 stored").hexdigest()
        project.purchase_request.file = ContentFile(b"only in memory")
        self.assertEqual(document_state(project.purchase_request), ("present", expected))

    def test_a_replacement_storage_cannot_read_keeps_its_name_without_a_new_version_later(self):
        project = self.file_project(b"first")
        with patch("procurement.project_documents.document_state", return_value=("unreadable", "")):
            self.revise(project, b"second")
        first, second = self.versions(project)
        self.assertEqual((second.version, second.sha256), (2, ""))
        self.assertEqual(second.file.name, project.purchase_request.name)
        # Readable again: the same stored file, so still version 2.
        manifest = blockchain.document_manifest(project)
        self.assertEqual(manifest["purchase_request"]["state"], "present")
        self.assertEqual(manifest["purchase_request"]["version"], 2)
        self.assertEqual(len(self.versions(project)), 2)

    def test_a_history_failure_never_breaks_the_action(self):
        with patch("procurement.project_documents._capture", side_effect=RuntimeError("db down")):
            project = self.file_project()
            self.revise(project, b"second")
        self.assertFalse(ProjectDocumentVersion.objects.filter(project=project).exists())
        self.assertEqual(project.status, Project.Status.PENDING_HEAD)

    def test_rows_are_write_once(self):
        project = self.file_project()
        row = self.versions(project)[0]
        original = row.sha256
        row.sha256 = "0x" + "0" * 64
        queryset = ProjectDocumentVersion.objects.filter(pk=row.pk)
        for attempt in (row.save, row.delete, queryset.delete, lambda: queryset.update(sha256=""),
                        lambda: ProjectDocumentVersion.objects.bulk_update([row], ["sha256"])):
            with self.assertRaises(TypeError):
                attempt()
        self.assertEqual(ProjectDocumentVersion.objects.get(pk=row.pk).sha256, original)

    def test_deleting_a_project_keeps_its_versions_and_their_files(self):
        project = self.file_project(b"kept")
        code, pk = project.code, project.pk
        row_pks = list(ProjectDocumentVersion.objects.filter(project=project).values_list("pk", flat=True))
        self.assertEqual(self.client.delete(f"/api/projects/{pk}/").status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Project.objects.filter(pk=pk).exists())
        rows = ProjectDocumentVersion.objects.filter(pk__in=row_pks)
        self.assertEqual(rows.count(), 5)
        for row in rows:
            self.assertIsNone(row.project)
            self.assertEqual(row.project_code, code)
        self.assertEqual(self.stored_bytes(rows.get(key="purchase_request")), b"%PDF-1.4 kept")


class PayloadV3GateTests(ProjectDocumentCase):
    """Writing is off and refused at start-up. The writer tests switch the flag on
    in-process only, which is the only way v3 can be written in this phase."""

    def _lifecycle(self):
        project = self.file_project()
        self.revise(project, b"second")
        self.client.force_authenticate(user=self.head)
        self.assertEqual(self.client.post(f"/api/projects/{project.pk}/approve/").status_code, 200)
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/projects/{project.pk}/publish/").status_code, 200)
        return project

    def test_the_flag_is_off_by_default_and_nothing_v3_is_written(self):
        self.assertIs(blockchain.PAYLOAD_V3_ENABLED, False)
        self.assertEqual(blockchain.PAYLOAD_VERSION, 2)
        self.assertNotIn(3, blockchain.PAYLOAD_RULES)
        with patch.object(payload_v3, "project_payload", side_effect=AssertionError("v3 builder called")), \
                patch.object(blockchain, "document_manifest", side_effect=AssertionError("manifest built")):
            project = self._lifecycle()
            win = Bid.objects.create(project=project, supplier=make_supplier(), amount=900,
                                     status=Bid.Status.QUALIFIED)
            self.assertEqual(self.client.post(f"/api/bids/{win.pk}/select-winner/").status_code, 200)
        anchors = BlockchainAnchor.objects.filter(entity_ref=project.code)
        self.assertEqual(
            sorted(set(anchors.values_list("stage", flat=True))),
            sorted({"SUBMITTED", "REVISION_REQUESTED", "HEAD_APPROVED", "BIDDING_OPEN",
                    "EVALUATION_COMPLETED", "BID_SUBMITTED", "AWARDED"}))
        for anchor in anchors:
            with self.subTest(anchor.stage):
                self.assertEqual(anchor.payload["v"], 2)
                self.assertNotIn("kind", anchor.payload)
                self.assertNotIn("documents", anchor.payload)
        # History-keeping is not v3 writing: it runs regardless of the flag.
        self.assertEqual(len(self.versions(project)), 2)

    def test_v2_anchors_verify_as_before_while_history_is_kept(self):
        project = self._lifecycle()
        submitted = BlockchainAnchor.objects.get(entity_ref=project.code, stage="SUBMITTED")
        self.assertEqual(verify_anchor(submitted)["status"], "match")
        # A replaced Purchase Request is still reported by the deep check.
        self.assertEqual(verify_anchor(submitted, deep=True)["document"], "mismatch")
        opened = BlockchainAnchor.objects.get(entity_ref=project.code, stage="BIDDING_OPEN")
        self.assertEqual(verify_anchor(opened, deep=True)["status"], "match")

    def test_the_gate_refuses_a_true_flag(self):
        blockchain.check_v3_gate(False)
        with self.assertRaisesMessage(ImproperlyConfigured, "PAYLOAD_V3_ENABLED"):
            blockchain.check_v3_gate(True)

    def test_app_start_runs_the_gate(self):
        from django.apps import apps
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            with self.assertRaisesMessage(ImproperlyConfigured, "PAYLOAD_V3_ENABLED"):
                apps.get_app_config("procurement").ready()
        apps.get_app_config("procurement").ready()

    def test_a_real_process_refuses_to_start_with_the_flag_on(self):
        """The whole path: environment variable, django.setup(), ready(). No
        database is touched: setup never connects."""
        import os
        import subprocess
        import sys
        from pathlib import Path
        from django.conf import settings
        backend = Path(settings.BASE_DIR)

        def start(value):
            env = {**os.environ, "DB_HOST": "", "DJANGO_SETTINGS_MODULE": "config.settings",
                   "PYTHONPATH": str(backend), "PYTHONIOENCODING": "utf-8", "PAYLOAD_V3_ENABLED": value}
            return subprocess.run([sys.executable, "-c", "import django; django.setup(); print('STARTED')"],
                                  cwd=backend, env=env, capture_output=True, text=True, encoding="utf-8",
                                  timeout=120)

        refused = start("true")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("ImproperlyConfigured", refused.stderr)
        self.assertNotIn("STARTED", refused.stdout)
        allowed = start("false")
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertIn("STARTED", allowed.stdout)

    def test_the_writer_records_a_valid_project_stage_payload(self):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            project = self.file_project()
        anchor = BlockchainAnchor.objects.get(entity_ref=project.code, stage="SUBMITTED")
        payload_v3.validate_project_stage(anchor.payload)
        self.assertEqual(anchor.payload["kind"], "project-stage/3")
        self.assertEqual(hash_payload(anchor.payload), anchor.data_hash)
        self.assertEqual(anchor.payload["document_key"], "purchase_request")
        self.assertEqual(anchor.document_hash, hash_file(project.purchase_request))
        self.assertEqual(anchor.document_hash, anchor.payload["document_hash"])
        for key in PROCUREMENT_DOCUMENT_KEYS:
            entry = anchor.payload["documents"][key]
            self.assertEqual(entry, {"state": "present", "sha256": hash_file(getattr(project, key)), "version": 1})

    def test_the_revision_loop_moves_the_version_and_earlier_anchors_keep_theirs(self):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            project = self.file_project(b"first")
            self.revise(project, b"second")
            self.client.force_authenticate(user=self.head)
            self.assertEqual(self.client.post(f"/api/projects/{project.pk}/approve/").status_code, 200)
        first, second = self.versions(project)
        submitted = BlockchainAnchor.objects.get(entity_ref=project.code, stage="SUBMITTED")
        approved = BlockchainAnchor.objects.get(entity_ref=project.code, stage="HEAD_APPROVED")
        self.assertEqual(submitted.payload["documents"]["purchase_request"],
                         {"state": "present", "sha256": first.sha256, "version": 1})
        self.assertEqual(approved.payload["documents"]["purchase_request"],
                         {"state": "present", "sha256": second.sha256, "version": 2})
        self.assertEqual(hash_payload(submitted.payload), submitted.data_hash)

    def test_reuploading_identical_bytes_leaves_the_next_manifest_identical(self):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            project = self.file_project(b"same")
            self.revise(project, b"same")
            self.client.force_authenticate(user=self.head)
            self.assertEqual(self.client.post(f"/api/projects/{project.pk}/approve/").status_code, 200)
        submitted = BlockchainAnchor.objects.get(entity_ref=project.code, stage="SUBMITTED")
        approved = BlockchainAnchor.objects.get(entity_ref=project.code, stage="HEAD_APPROVED")
        self.assertEqual(submitted.payload["documents"], approved.payload["documents"])

    def test_a_document_never_uploaded_is_absent_at_version_zero(self):
        project = self.legacy_project(purchase_request=b"pr")
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        entry = anchor.payload["documents"]["terms_of_reference"]
        self.assertEqual(entry, {"state": "absent", "sha256": "", "version": 0})
        # "" is not a digest, so no file a verifier could choose ever matches it.
        self.assertNotEqual(hash_file(project.purchase_request), entry["sha256"])
        self.assertEqual(self.versions(project, "terms_of_reference"), [])

    def test_storage_failing_while_hashing_records_unreadable_and_the_transition_succeeds(self):
        project = self.file_project()
        self.client.force_authenticate(user=self.head)
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True), \
                patch("django.db.models.fields.files.FieldFile.open", side_effect=OSError("storage down")):
            res = self.client.post(f"/api/projects/{project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        self.assertEqual(project.status, Project.Status.APPROVED)
        anchor = BlockchainAnchor.objects.get(entity_ref=project.code, stage="HEAD_APPROVED")
        for key in PROCUREMENT_DOCUMENT_KEYS:
            self.assertEqual(anchor.payload["documents"][key], {"state": "unreadable", "sha256": "", "version": 1})
        self.assertEqual(anchor.document_hash, "")

    def test_a_writer_failure_leaves_no_anchor_and_the_transition_succeeds(self):
        project = self.file_project()
        self.client.force_authenticate(user=self.head)
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True), \
                patch.object(payload_v3, "project_payload", side_effect=NonCanonicalPayload("bad")):
            res = self.client.post(f"/api/projects/{project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertFalse(BlockchainAnchor.objects.filter(entity_ref=project.code, stage="HEAD_APPROVED").exists())

    def test_the_builder_never_returns_a_payload_outside_the_schema(self):
        project = self.file_project()
        project.budget = -1
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            self.assertIsNone(blockchain.anchor_project(project, BlockchainAnchor.Stage.HEAD_APPROVED))
        self.assertFalse(BlockchainAnchor.objects.filter(entity_ref=project.code, stage="HEAD_APPROVED").exists())

    def test_with_signing_off_a_v3_anchor_is_stored_and_nothing_is_sent(self):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True), \
                patch.object(blockchain, "WALLET_SIGNING_ENABLED", False), \
                patch.object(blockchain, "submit_anchor_server_side") as submit:
            project = self.file_project()
        submit.assert_not_called()
        anchor = BlockchainAnchor.objects.get(entity_ref=project.code, stage="SUBMITTED")
        self.assertEqual(anchor.payload["v"], 3)
        self.assertEqual(anchor.tx_hash, "")

    def test_a_v3_anchor_verifies_now_that_its_reader_has_shipped(self):
        # Until Phase 4 this read "unavailable". The other guards above are unchanged.
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            project = self.file_project()
        anchor = BlockchainAnchor.objects.get(entity_ref=project.code, stage="SUBMITTED")
        self.assertEqual(verify_anchor(anchor, deep=True)["status"], "match")


# ── Stage 5 Phase 3: commitments and encrypted openings ──────────────────────

def throwaway_key():
    from cryptography.fernet import Fernet
    return Fernet.generate_key().decode()


class CommitmentPayloadTests(APITestCase):
    def _leaf(self):
        return json.loads(json.dumps(vector_named("bid-leaf/3, winning")["payload"]))

    def _private(self):
        return json.loads(json.dumps(vector_named("award-private/3")["payload"]))

    def test_the_shared_vectors_pass_the_schema_and_fit_together(self):
        win, lose = vector_named("bid-leaf/3, winning"), vector_named("bid-leaf/3, losing")
        evaluation = vector_named("evaluation/3")
        for vector in (win, lose):
            payload_v3.validate_opening(vector["payload"])
        payload_v3.validate_opening(self._private())
        payload_v3.validate_evaluation(evaluation["payload"])
        self.assertEqual(evaluation["payload"]["leaves"], sorted([win["data_hash"], lose["data_hash"]]))
        self.assertEqual(hash_payload(evaluation["payload"]), evaluation["data_hash"])

    def test_the_builders_produce_the_vectors_exactly(self):
        from datetime import datetime
        from decimal import Decimal
        from types import SimpleNamespace
        from zoneinfo import ZoneInfo
        manila = ZoneInfo("Asia/Manila")
        leaf = self._leaf()
        bid = SimpleNamespace(id=leaf["bid_id"], supplier_id=leaf["supplier_id"], amount=Decimal(leaf["amount"]),
                              submitted_at=datetime(2026, 11, 3, 16, 15, 0, 123456, tzinfo=manila), status=leaf["status"])
        self.assertEqual(payload_v3.bid_leaf_opening(bid, leaf["document_hash"], leaf["salt"]), leaf)
        private = self._private()
        award = SimpleNamespace(
            id=private["award_id"], bid_id=private["bid_id"], supplier_id=private["supplier_id"],
            status=private["status"],
            project=SimpleNamespace(awarded_at=datetime(2026, 11, 3, 17, 30, 0, 654321, tzinfo=manila)))
        self.assertEqual(payload_v3.award_private_opening(award, private["salt"]), private)
        evaluation = vector_named("evaluation/3")
        project = SimpleNamespace(code=evaluation["payload"]["code"])
        self.assertEqual(payload_v3.evaluation_payload(project, list(reversed(evaluation["payload"]["leaves"]))),
                         evaluation["payload"])

    def test_an_award_with_no_exact_time_is_refused_not_filled_in(self):
        from types import SimpleNamespace
        award = SimpleNamespace(id=4, bid_id=9, supplier_id=3, status="won",
                                project=SimpleNamespace(awarded_at=None))
        with self.assertRaises(NonCanonicalPayload):
            payload_v3.award_private_opening(award, "33" * 32)

    def test_leaves_in_bid_id_order_give_a_different_hash_and_are_refused(self):
        payload = vector_named("evaluation/3")["payload"]
        unsorted_payload = {**payload, "leaves": list(reversed(payload["leaves"]))}
        self.assertNotEqual(hash_payload(unsorted_payload), hash_payload(payload))
        with self.assertRaises(NonCanonicalPayload):
            payload_v3.validate_evaluation(unsorted_payload)

    def test_an_evaluation_outside_the_schema_is_refused(self):
        payload = vector_named("evaluation/3")["payload"]
        leaf = payload["leaves"][0]
        cases = {
            "repeated leaf": {"leaves": [leaf, leaf]},
            "wrong count": {"bid_count": 3},
            "not a hash": {"leaves": ["0xabc"], "bid_count": 1},
            "uppercase hash": {"leaves": [leaf.upper().replace("0X", "0x")], "bid_count": 1},
            "leaves not an array": {"leaves": leaf},
            "wrong kind": {"kind": "project-stage/3"},
            "wrong version": {"v": 2},
            "wrong stage": {"stage": "AWARDED"},
            "extra field": {"amount": "1.00"},
        }
        for name, change in cases.items():
            with self.subTest(name):
                with self.assertRaises(NonCanonicalPayload):
                    payload_v3.validate_evaluation({**payload, **change})

    def test_an_opening_outside_the_schema_is_refused(self):
        cases = {
            "empty salt": {"salt": ""},
            "short salt": {"salt": "ab" * 31},
            "uppercase salt": {"salt": "AB" * 32},
            "no kind": {"kind": ""},
            "unknown kind": {"kind": "evaluation/3"},
            "extra field": {"extra": "x"},
            "amount as a number": {"amount": 229900},
            "local time": {"submitted_at": "2026-11-03T16:15:00+08:00"},
            "bad document hash": {"document_hash": "abc"},
            "null status": {"status": None},
            "boolean id": {"bid_id": True},
            "negative id": {"bid_id": -1},
        }
        for name, change in cases.items():
            with self.subTest(name):
                with self.assertRaises(NonCanonicalPayload):
                    payload_v3.validate_opening({**self._leaf(), **change})

    def test_validation_errors_never_contain_the_salt(self):
        for bad in ({**self._leaf(), "salt": "AB" * 32}, {**self._private(), "salt": "CD" * 32, "extra": "x"}):
            with self.assertRaises(NonCanonicalPayload) as caught:
                payload_v3.validate_opening(bad)
            self.assertNotIn(bad["salt"], str(caught.exception))

    def test_decision_a_lives_in_one_list_and_the_amount_stays_out_for_now(self):
        self.assertEqual(set(self._private()) - {"kind", "salt"}, set(payload_v3.AWARD_PRIVATE_FIELDS))
        self.assertNotIn("amount", payload_v3.AWARD_PRIVATE_FIELDS)
        with self.assertRaises(NonCanonicalPayload):
            payload_v3.validate_opening({**self._private(), "amount": "229900.00"})

    def test_ten_thousand_commitments_have_ten_thousand_distinct_salts(self):
        salts, commitments = set(), set()
        leaf = self._leaf()
        for _ in range(10000):
            salt = openings.new_salt()
            self.assertRegex(salt, r"\A[0-9a-f]{64}\Z")
            salts.add(salt)
            commitments.add(hash_payload({**leaf, "salt": salt}))
        self.assertEqual((len(salts), len(commitments)), (10000, 10000))

    def test_salts_come_from_the_secure_generator(self):
        with patch("procurement.openings.secrets.token_bytes", return_value=b"\x01" * 32) as source:
            self.assertEqual(openings.new_salt(), "01" * 32)
        source.assert_called_once_with(32)

    def test_a_wrong_salt_never_opens_a_commitment(self):
        leaf = self._leaf()
        commitment = hash_payload(leaf)
        self.assertTrue(openings.opening_matches(leaf, commitment))
        flipped = format(int(leaf["salt"], 16) ^ 1, "064x")
        for name, salt in {"one bit flipped": flipped, "another bidder's": "22" * 32, "empty": ""}.items():
            with self.subTest(name):
                self.assertFalse(openings.opening_matches({**leaf, "salt": salt}, commitment))

    def test_a_changed_field_never_opens_a_commitment(self):
        leaf = self._leaf()
        commitment = hash_payload(leaf)
        for change in ({"amount": "229900.01"}, {"status": "qualified"}, {"bid_id": 10}):
            self.assertFalse(openings.opening_matches({**leaf, **change}, commitment))

    def test_a_bid_leaf_can_not_be_presented_as_an_award_commitment_or_the_reverse(self):
        leaf, private = self._leaf(), self._private()
        self.assertFalse(openings.opening_matches({**leaf, "kind": "award-private/3"}, hash_payload(leaf)))
        self.assertFalse(openings.opening_matches({**private, "kind": "bid-leaf/3"}, hash_payload(private)))

    def test_the_salt_is_what_stops_a_brute_force_of_the_amount(self):
        leaf = self._leaf()
        secret_amount = "734.25"

        def search(commitment, salt):
            for centavos in range(0, 100000):
                amount = f"{centavos // 100}.{centavos % 100:02d}"
                if hash_payload({**leaf, "amount": amount, "salt": salt}) == commitment:
                    return amount
            return None

        without_salt = hash_payload({**leaf, "amount": secret_amount, "salt": ""})
        self.assertEqual(search(without_salt, ""), secret_amount)
        salted = hash_payload({**leaf, "amount": secret_amount, "salt": openings.new_salt()})
        self.assertIsNone(search(salted, ""))


class CommitmentOpeningCase(APITestCase):
    """Synthetic v3 anchors (nothing in the app writes them yet) and a throwaway key."""

    def setUp(self):
        cache.clear()
        self.key = throwaway_key()
        override = override_settings(COMMITMENT_KEY=self.key, COMMITMENT_OLD_KEYS="")
        override.enable()
        self.addCleanup(override.disable)
        self.project = make_project()
        self.supplier = make_supplier()
        self.other = make_supplier()
        self.bid = Bid.objects.create(project=self.project, supplier=self.supplier, amount=900)
        self.other_bid = Bid.objects.create(project=self.project, supplier=self.other, amount=950)

    def leaf(self, bid=None):
        return payload_v3.bid_leaf_opening(bid or self.bid, "", openings.new_salt())

    def anchor_for(self, payload, stage="EVALUATION_COMPLETED"):
        return BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT, entity_ref=self.project.code,
            entity_id=str(self.project.id), stage=stage, data_hash=hash_payload(payload), payload=payload)

    def evaluation(self):
        """An evaluation anchor with both bids' leaves stored."""
        first, second = self.leaf(self.bid), self.leaf(self.other_bid)
        anchor = self.anchor_for(payload_v3.evaluation_payload(
            self.project, [hash_payload(first), hash_payload(second)]))
        rows = (openings.store_opening(anchor, self.bid.id, first, self.supplier),
                openings.store_opening(anchor, self.other_bid.id, second, self.other))
        return anchor, rows, (first, second)

    def award_issue(self, award):
        """One award-document issue, with its own salt, commitment and anchor."""
        opening = payload_v3.award_private_opening(award, openings.new_salt())
        anchor = self.anchor_for({"v": 3, "kind": "award-document/3", "stage": "NOA_ISSUED",
                                  "private_commitment": hash_payload(opening)}, stage="NOA_ISSUED")
        return anchor, openings.store_opening(anchor, award.id, opening, award.supplier), opening

    def make_award(self):
        self.project.awarded_at = timezone.now()
        self.project.save(update_fields=["awarded_at"])
        return Award.objects.create(project=self.project, bid=self.bid, supplier=self.supplier, amount=900)

    @staticmethod
    def run_command(name, *args):
        out = io.StringIO()
        call_command(name, *args, stdout=out)
        return out.getvalue()


class CommitmentOpeningStoreTests(CommitmentOpeningCase):
    def test_an_opening_is_stored_encrypted_and_reads_back_exactly(self):
        anchor, (row, _), (opening, _) = self.evaluation()
        row = CommitmentOpening.objects.get(pk=row.pk)
        self.assertEqual(openings.decrypt_opening(row), opening)
        self.assertEqual(row.commitment, hash_payload(opening))
        self.assertEqual(row.key_fingerprint, openings.key_fingerprint(self.key))
        self.assertRegex(row.key_fingerprint, r"\A[0-9a-f]{8}\Z")
        stored = " ".join(str(getattr(row, f.attname)) for f in row._meta.fields)
        for secret in (opening["salt"], opening["amount"], self.key):
            self.assertNotIn(secret, stored)
        self.assertNotEqual(row.salt_fingerprint, opening["salt"])
        self.assertEqual(openings.check_opening(row), openings.MATCH)

    def test_with_no_key_nothing_is_stored(self):
        anchor = self.anchor_for({"v": 3, "kind": "evaluation/3"})
        for key in ("", "not-a-fernet-key"):
            with self.subTest(key), override_settings(COMMITMENT_KEY=key):
                with self.assertRaises(openings.OpeningsNotConfigured):
                    openings.store_opening(anchor, self.bid.id, self.leaf())
        self.assertFalse(CommitmentOpening.objects.exists())

    def test_the_file_encryption_key_is_never_a_fallback(self):
        anchor = self.anchor_for({"v": 3, "kind": "evaluation/3"})
        with override_settings(COMMITMENT_KEY="", FILE_ENCRYPTION_KEY=throwaway_key()):
            with self.assertRaises(openings.OpeningsNotConfigured):
                openings.store_opening(anchor, self.bid.id, self.leaf())

    def test_an_opening_outside_the_schema_is_not_stored(self):
        anchor = self.anchor_for({"v": 3, "kind": "evaluation/3"})
        with self.assertRaises(NonCanonicalPayload):
            openings.store_opening(anchor, self.bid.id, {**self.leaf(), "salt": ""})
        self.assertFalse(CommitmentOpening.objects.exists())

    def test_a_second_commit_on_the_same_anchor_changes_nothing(self):
        anchor, (row, _), (opening, _) = self.evaluation()
        before = CommitmentOpening.objects.filter(pk=row.pk).values().get()
        with self.assertRaises(openings.OpeningAlreadyStored):
            openings.store_opening(anchor, self.bid.id, self.leaf(), self.supplier)
        self.assertEqual(CommitmentOpening.objects.filter(pk=row.pk).values().get(), before)
        self.assertEqual(openings.decrypt_opening(row), opening)

    def test_the_database_refuses_a_salt_used_on_another_anchor(self):
        _, _, (opening, _) = self.evaluation()
        another = self.anchor_for({"v": 3, "kind": "evaluation/3"})
        with self.assertRaises(openings.OpeningAlreadyStored):
            openings.store_opening(another, self.bid.id, opening)
        self.assertEqual(another.openings.count(), 0)

    def test_three_issues_keep_three_salts_commitments_and_openings(self):
        award = self.make_award()
        issues = [self.award_issue(award) for _ in range(3)]
        self.assertEqual(len({opening["salt"] for _, _, opening in issues}), 3)
        self.assertEqual(len({row.commitment for _, row, _ in issues}), 3)
        self.assertEqual(len({anchor.pk for anchor, _, _ in issues}), 3)
        for anchor, row, opening in issues:
            self.assertEqual(openings.decrypt_opening(row), opening)
            self.assertEqual(openings.check_opening(row), openings.MATCH)
            self.assertEqual(anchor.payload["private_commitment"], hash_payload(opening))

    def test_rows_are_write_once(self):
        _, (row, _), _ = self.evaluation()
        queryset = CommitmentOpening.objects.filter(pk=row.pk)
        before = queryset.values().get()
        row.commitment = "0x" + "0" * 64
        for attempt in (row.save, row.delete, queryset.delete, lambda: queryset.update(commitment=""),
                        lambda: CommitmentOpening.objects.bulk_update([row], ["commitment"])):
            with self.assertRaises(TypeError):
                attempt()
        self.assertEqual(queryset.values().get(), before)

    def test_an_anchor_with_an_opening_can_not_be_deleted(self):
        from django.db.models import ProtectedError
        anchor, _, _ = self.evaluation()
        with self.assertRaises(ProtectedError):
            anchor.delete()

    def test_deleting_a_supplier_keeps_their_opening(self):
        _, (row, _), (opening, _) = self.evaluation()
        self.bid.delete()
        Supplier.objects.filter(pk=self.supplier.pk).delete()
        row = CommitmentOpening.objects.get(pk=row.pk)
        self.assertIsNone(row.supplier)
        self.assertEqual(openings.decrypt_opening(row), opening)

    def test_a_stale_rewrap_changes_nothing(self):
        _, (row, _), _ = self.evaluation()
        self.assertFalse(CommitmentOpening.rewrap(row.pk, "stale", "new", "00000000"))
        self.assertEqual(CommitmentOpening.objects.get(pk=row.pk).ciphertext, row.ciphertext)

    def test_a_ciphertext_swapped_from_another_anchor_is_refused(self):
        _, (row, _), _ = self.evaluation()
        _, foreign, _ = self.award_issue(self.make_award())
        CommitmentOpening.rewrap(row.pk, row.ciphertext, foreign.ciphertext, row.key_fingerprint)
        row = CommitmentOpening.objects.get(pk=row.pk)
        with self.assertRaises(openings.OpeningMismatch):
            openings.decrypt_opening(row)
        self.assertEqual(openings.check_opening(row), openings.MISMATCH)

    def test_a_ciphertext_swapped_between_two_leaves_of_one_anchor_is_refused(self):
        """Same anchor_id, same kind: only the commitment tells these two apart."""
        _, (row, other_row), _ = self.evaluation()
        CommitmentOpening.rewrap(row.pk, row.ciphertext, other_row.ciphertext, row.key_fingerprint)
        row = CommitmentOpening.objects.get(pk=row.pk)
        with self.assertRaises(openings.OpeningMismatch):
            openings.decrypt_opening(row)

    def _forge(self, row, anchor_id, kind, opening):
        """A ciphertext made with the real key, as someone with database and key
        access could: the row's own checks are all that stand in its way."""
        token = openings._keyring().encrypt(openings._plaintext(anchor_id, kind, opening)).decode("ascii")
        CommitmentOpening.rewrap(row.pk, row.ciphertext, token, row.key_fingerprint)
        return CommitmentOpening.objects.get(pk=row.pk)

    def test_a_forged_ciphertext_for_another_anchor_is_refused(self):
        anchor, (row, _), (opening, _) = self.evaluation()
        forged = self._forge(row, anchor.pk + 1000, row.kind, opening)
        with self.assertRaises(openings.OpeningMismatch):
            openings.decrypt_opening(forged)

    def test_a_forged_ciphertext_of_another_kind_is_refused(self):
        anchor, (row, _), (opening, _) = self.evaluation()
        forged = self._forge(row, anchor.pk, "award-private/3", opening)
        with self.assertRaises(openings.OpeningMismatch):
            openings.decrypt_opening(forged)

    def test_a_forged_opening_with_a_changed_amount_is_refused(self):
        anchor, (row, _), (opening, _) = self.evaluation()
        forged = self._forge(row, anchor.pk, row.kind, {**opening, "amount": "1.00"})
        with self.assertRaises(openings.OpeningMismatch):
            openings.decrypt_opening(forged)

    def test_an_opening_whose_salt_fingerprint_was_changed_is_refused(self):
        _, (row, _), _ = self.evaluation()
        QuerySet(model=CommitmentOpening).filter(pk=row.pk).update(salt_fingerprint="0" * 64)
        self.assertEqual(openings.check_opening(CommitmentOpening.objects.get(pk=row.pk)), openings.MISMATCH)

    def test_a_commitment_the_anchor_never_recorded_is_a_mismatch(self):
        opening = self.leaf()
        anchor = self.anchor_for(payload_v3.evaluation_payload(self.project, ["0x" + "a" * 64]))
        row = openings.store_opening(anchor, self.bid.id, opening, self.supplier)
        self.assertEqual(openings.check_opening(row), openings.MISMATCH)

    def test_a_leaf_filed_under_an_award_document_anchor_is_a_mismatch(self):
        opening = self.leaf()
        anchor = self.anchor_for({"v": 3, "kind": "award-document/3", "private_commitment": hash_payload(opening)})
        row = openings.store_opening(anchor, self.bid.id, opening, self.supplier)
        self.assertEqual(openings.check_opening(row), openings.MISMATCH)

    def test_a_commitment_in_a_payload_of_the_wrong_kind_is_a_mismatch(self):
        opening = self.leaf()
        anchor = self.anchor_for({"v": 3, "kind": "project-stage/3", "leaves": [hash_payload(opening)]})
        row = openings.store_opening(anchor, self.bid.id, opening, self.supplier)
        self.assertEqual(openings.check_opening(row), openings.MISMATCH)

    def test_an_edited_anchor_row_is_a_mismatch(self):
        anchor, (row, _), _ = self.evaluation()
        BlockchainAnchor.objects.filter(pk=anchor.pk).update(data_hash="0x" + "f" * 64)
        self.assertEqual(openings.check_opening(CommitmentOpening.objects.get(pk=row.pk)), openings.MISMATCH)

    def test_a_lost_key_is_unavailable_and_never_a_mismatch(self):
        anchor, (row, _), _ = self.evaluation()
        for current in (throwaway_key(), ""):
            with self.subTest(has_key=bool(current)), override_settings(COMMITMENT_KEY=current):
                fresh = CommitmentOpening.objects.get(pk=row.pk)
                self.assertEqual(openings.check_opening(fresh), openings.UNAVAILABLE)
                with self.assertRaises(openings.OpeningUnavailable):
                    openings.read_opening(None, make_admin_once(), fresh)
                with self.assertRaises(CommandError) as caught:
                    self.run_command("check_commitment_openings")
                self.assertIn("mismatch 0, unavailable 2", str(caught.exception))
        # Public integrity doesn't need the key.
        self.assertEqual(hash_payload(anchor.payload), anchor.data_hash)

    def test_check_command_reports_success_and_writes_nothing(self):
        self.evaluation()
        before = list(CommitmentOpening.objects.values())
        anchors_before = list(BlockchainAnchor.objects.values())
        output = self.run_command("check_commitment_openings")
        self.assertIn("Match 2, mismatch 0, unavailable 0.", output)
        self.assertIn(openings.key_fingerprint(self.key), output)
        self.assertEqual(list(CommitmentOpening.objects.values()), before)
        self.assertEqual(list(BlockchainAnchor.objects.values()), anchors_before)

    def test_check_command_fails_on_a_mismatch(self):
        _, (row, other_row), _ = self.evaluation()
        CommitmentOpening.rewrap(row.pk, row.ciphertext, other_row.ciphertext, row.key_fingerprint)
        with self.assertRaises(CommandError) as caught:
            self.run_command("check_commitment_openings")
        self.assertIn("mismatch 1", str(caught.exception))


def make_admin_once():
    return User.objects.filter(username="admin").first() or make_admin()


class CommitmentKeyRotationTests(CommitmentOpeningCase):
    def _rotated_settings(self):
        new_key = throwaway_key()
        return new_key, override_settings(COMMITMENT_KEY=new_key, COMMITMENT_OLD_KEYS=self.key)

    def test_rotation_moves_every_opening_to_the_new_key_and_nothing_else(self):
        anchor, rows, plain = self.evaluation()
        fixed = ("anchor_id", "kind", "subject_id", "commitment", "salt_fingerprint", "supplier_id", "created_at")
        before = list(CommitmentOpening.objects.order_by("pk").values(*fixed))
        anchor_before = BlockchainAnchor.objects.filter(pk=anchor.pk).values().get()
        ciphertexts = list(CommitmentOpening.objects.order_by("pk").values_list("ciphertext", flat=True))
        new_key, settings_override = self._rotated_settings()
        with settings_override:
            dry = self.run_command("rotate_commitment_openings")
            self.assertIn("Would re-encrypt 2, already current 0, unavailable 0.", dry)
            self.assertEqual(list(CommitmentOpening.objects.order_by("pk").values_list("ciphertext", flat=True)),
                             ciphertexts)
            applied = self.run_command("rotate_commitment_openings", "--apply")
            self.assertIn("Re-encrypted 2, already current 0, unavailable 0.", applied)
            self.assertIn("No openings are left under a retired key.", applied)
            again = self.run_command("rotate_commitment_openings", "--apply")
            self.assertIn("Re-encrypted 0, already current 2, unavailable 0.", again)
        self.assertEqual(list(CommitmentOpening.objects.order_by("pk").values(*fixed)), before)
        self.assertEqual(BlockchainAnchor.objects.filter(pk=anchor.pk).values().get(), anchor_before)
        # Under the new key ALONE.
        with override_settings(COMMITMENT_KEY=new_key, COMMITMENT_OLD_KEYS=""):
            for row, opening in zip(CommitmentOpening.objects.order_by("pk"), plain):
                self.assertEqual(row.key_fingerprint, openings.key_fingerprint(new_key))
                self.assertEqual(openings.decrypt_opening(row), opening)
                self.assertEqual(openings.check_opening(row), openings.MATCH)
        # The retired key no longer opens them.
        with override_settings(COMMITMENT_KEY=self.key, COMMITMENT_OLD_KEYS=""):
            self.assertEqual(openings.check_opening(CommitmentOpening.objects.first()), openings.UNAVAILABLE)

    def test_a_row_no_key_opens_is_left_alone_and_reported(self):
        _, (row, _), _ = self.evaluation()
        with override_settings(COMMITMENT_KEY=throwaway_key(), COMMITMENT_OLD_KEYS=""):
            output = self.run_command("rotate_commitment_openings", "--apply")
        self.assertIn("unavailable 2.", output)
        self.assertIn("Do not remove a key", output)
        self.assertNotIn("No openings are left", output)
        self.assertEqual(CommitmentOpening.objects.get(pk=row.pk).ciphertext, row.ciphertext)

    def test_rotation_needs_a_current_key(self):
        with override_settings(COMMITMENT_KEY=""):
            with self.assertRaisesMessage(CommandError, "COMMITMENT_KEY is not set"):
                self.run_command("rotate_commitment_openings")

    def test_a_dry_run_does_not_claim_a_retired_key_is_clear(self):
        self.evaluation()
        _, settings_override = self._rotated_settings()
        with settings_override:
            self.assertNotIn("No openings are left", self.run_command("rotate_commitment_openings"))


class CommitmentOpeningAccessTests(CommitmentOpeningCase):
    def setUp(self):
        super().setUp()
        self.anchor, (self.row, self.other_row), (self.opening, _) = self.evaluation()
        self.admin, self.head = make_admin(), make_head()

    def _audits(self, action):
        return AuditLog.objects.filter(action=action, entity_id=str(self.anchor.pk))

    def test_admin_and_head_read_every_opening_and_each_read_is_audited(self):
        for user in (self.admin, self.head):
            for row in (self.row, self.other_row):
                self.assertTrue(openings.read_opening(None, user, row))
            self.assertEqual(self._audits("commitment.opened").filter(user=user).count(), 2)

    def test_a_supplier_reads_only_their_own(self):
        self.assertEqual(openings.read_opening(None, self.supplier.user, self.row), self.opening)
        self.assertEqual(self._audits("commitment.opened").filter(user=self.supplier.user).count(), 1)
        with self.assertRaises(openings.OpeningAccessDenied):
            openings.read_opening(None, self.supplier.user, self.other_row)
        self.assertEqual(self._audits("commitment.open_denied").filter(user=self.supplier.user).count(), 1)

    def test_an_awardee_reads_their_own_award_opening_only(self):
        _, row, opening = self.award_issue(self.make_award())
        self.assertEqual(openings.read_opening(None, self.supplier.user, row), opening)
        with self.assertRaises(openings.OpeningAccessDenied):
            openings.read_opening(None, self.other.user, row)

    def test_the_public_and_inactive_accounts_read_none(self):
        from django.contrib.auth.models import AnonymousUser
        self.admin.is_active = False
        self.admin.save(update_fields=["is_active"])
        for user in (AnonymousUser(), None, self.admin):
            with self.subTest(str(user)):
                self.assertFalse(openings.may_read_opening(user, self.row))
                with self.assertRaises(openings.OpeningAccessDenied):
                    openings.read_opening(None, user, self.row)
        self.assertFalse(self._audits("commitment.opened").exists())

    def test_a_row_whose_supplier_is_gone_is_for_admin_and_head_only(self):
        self.bid.delete()
        Supplier.objects.filter(pk=self.supplier.pk).delete()
        row = CommitmentOpening.objects.get(pk=self.row.pk)
        self.assertFalse(openings.may_read_opening(self.other.user, row))
        self.assertTrue(openings.may_read_opening(self.head, row))

    def test_no_salt_or_key_reaches_logs_audit_text_output_or_errors(self):
        import logging

        class Capture(logging.Handler):
            def __init__(self):
                super().__init__(level=logging.DEBUG)
                self.lines = []

            def emit(self, record):
                self.lines.append(self.format(record))

        capture = Capture()
        capture.setFormatter(logging.Formatter("%(name)s %(message)s %(exc_text)s"))
        root = logging.getLogger()
        previous = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.removeHandler, capture)
        self.addCleanup(root.setLevel, previous)

        texts = []
        openings.read_opening(None, self.admin, self.row)
        with self.assertRaises(openings.OpeningAccessDenied) as denied:
            openings.read_opening(None, self.other.user, self.row)
        texts.append(str(denied.exception))
        with self.assertRaises(openings.OpeningAlreadyStored) as repeated:
            openings.store_opening(self.anchor, self.bid.id, self.opening)
        texts.append(str(repeated.exception))
        with self.assertRaises(NonCanonicalPayload) as invalid:
            openings.store_opening(self.anchor, self.bid.id, {**self.opening, "extra": "x"})
        texts.append(str(invalid.exception))
        texts.append(self.run_command("check_commitment_openings"))
        new_key = throwaway_key()
        with override_settings(COMMITMENT_KEY=new_key, COMMITMENT_OLD_KEYS=self.key):
            texts.append(self.run_command("rotate_commitment_openings", "--apply"))
        with override_settings(COMMITMENT_KEY=throwaway_key(), COMMITMENT_OLD_KEYS=""):
            with self.assertRaises(openings.OpeningUnavailable) as lost:
                openings.decrypt_opening(CommitmentOpening.objects.get(pk=self.row.pk))
            texts.append(str(lost.exception))
        CommitmentOpening.rewrap(self.row.pk, CommitmentOpening.objects.get(pk=self.row.pk).ciphertext,
                                 self.other_row.ciphertext, "00000000")
        texts += [str(self.row), repr(self.row)]
        texts += list(AuditLog.objects.values_list("description", flat=True))
        texts += capture.lines
        self.assertTrue(AuditLog.objects.filter(action="commitment.opened").exists())
        everything = "\n".join(texts)
        for secret in (self.opening["salt"], self.key, new_key, self.row.ciphertext):
            self.assertNotIn(secret, everything)


class CommitmentGateTests(CommitmentOpeningCase):
    def test_a_valid_key_does_not_lift_the_refusal(self):
        with self.assertRaisesMessage(ImproperlyConfigured, "PAYLOAD_V3_ENABLED is on"):
            blockchain.check_v3_gate(True)

    def test_the_refusal_also_reports_a_missing_or_invalid_key(self):
        for key, message in (("", "COMMITMENT_KEY is not set"), ("bad", "COMMITMENT_KEY is not a valid Fernet key")):
            with self.subTest(key), override_settings(COMMITMENT_KEY=key):
                with self.assertRaisesMessage(ImproperlyConfigured, message) as caught:
                    blockchain.check_v3_gate(True)
                self.assertIn("PAYLOAD_V3_ENABLED is on", str(caught.exception))
        with override_settings(COMMITMENT_OLD_KEYS="bad"):
            with self.assertRaisesMessage(ImproperlyConfigured, "COMMITMENT_OLD_KEYS entry 1"):
                blockchain.check_v3_gate(True)

    def test_flag_off_needs_no_key(self):
        with override_settings(COMMITMENT_KEY=""):
            blockchain.check_v3_gate(False)

    def test_problem_messages_never_contain_a_key(self):
        with override_settings(COMMITMENT_KEY="bad-key-value", COMMITMENT_OLD_KEYS="old-bad-value"):
            text = " ".join(openings.commitment_key_problems())
        self.assertNotIn("bad-key-value", text)
        self.assertNotIn("old-bad-value", text)

    def test_start_up_logs_only_fingerprints(self):
        from django.apps import apps
        old = throwaway_key()
        with override_settings(COMMITMENT_OLD_KEYS=old), self.assertLogs("procurement.security", "WARNING") as logs:
            apps.get_app_config("procurement").ready()
        output = "\n".join(logs.output)
        self.assertIn(f"COMMITMENT_KEY fingerprint: {openings.key_fingerprint(self.key)}", output)
        self.assertIn(f"COMMITMENT_OLD_KEYS fingerprint: {openings.key_fingerprint(old)}", output)
        self.assertNotIn(self.key, output)
        self.assertNotIn(old, output)

    def test_a_bad_key_with_the_flag_off_is_reported_without_stopping_the_app(self):
        from django.apps import apps
        with override_settings(COMMITMENT_KEY="bad-key-value"), \
                self.assertLogs("procurement.security", "ERROR") as logs:
            apps.get_app_config("procurement").ready()
        self.assertIn("COMMITMENT_KEY is not a valid Fernet key", "\n".join(logs.output))
        self.assertNotIn("bad-key-value", "\n".join(logs.output))

    def test_a_real_process_with_the_flag_on_and_a_key_still_refuses_without_printing_it(self):
        import os
        import subprocess
        import sys
        from pathlib import Path
        from django.conf import settings
        backend = Path(settings.BASE_DIR)
        key = throwaway_key()
        env = {**os.environ, "DB_HOST": "", "DJANGO_SETTINGS_MODULE": "config.settings", "PYTHONPATH": str(backend),
               "PYTHONIOENCODING": "utf-8", "PAYLOAD_V3_ENABLED": "true", "COMMITMENT_KEY": key}
        out = subprocess.run([sys.executable, "-c", "import django; django.setup(); print('STARTED')"],
                             cwd=backend, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("ImproperlyConfigured", out.stderr)
        self.assertNotIn("STARTED", out.stdout)
        self.assertNotIn(key, out.stdout + out.stderr)

    def test_the_settings_ship_no_default_key(self):
        from pathlib import Path
        from django.conf import settings
        source = (Path(settings.BASE_DIR) / "config" / "settings.py").read_text(encoding="utf-8")
        self.assertIn("os.environ.get('COMMITMENT_KEY', '')", source)
        self.assertIn("os.environ.get('COMMITMENT_OLD_KEYS', '')", source)

    def test_a_full_lifecycle_submits_no_transaction_and_opens_no_connection(self):
        admin, head = make_admin(), make_head()
        project = make_project(status=Project.Status.PENDING_HEAD)
        with patch.object(blockchain, "submit_anchor_server_side") as submit, \
                patch("socket.socket.connect", side_effect=AssertionError("network used")) as connect:
            self.client.force_authenticate(user=head)
            self.assertEqual(self.client.post(f"/api/projects/{project.pk}/approve/").status_code, 200)
            self.client.force_authenticate(user=admin)
            self.assertEqual(self.client.post(f"/api/projects/{project.pk}/publish/").status_code, 200)
            win = Bid.objects.create(project=project, supplier=self.supplier, amount=900, status=Bid.Status.QUALIFIED)
            self.assertEqual(self.client.post(f"/api/bids/{win.pk}/select-winner/").status_code, 200)
        submit.assert_not_called()
        connect.assert_not_called()
        self.assertFalse(BlockchainAnchor.objects.filter(entity_ref=project.code).exclude(tx_hash="").exists())

    def test_with_the_flag_off_a_full_lifecycle_writes_no_opening_and_only_v2(self):
        admin, head = make_admin(), make_head()
        project = make_project(status=Project.Status.PENDING_HEAD)
        with patch.object(openings, "store_opening", side_effect=AssertionError("opening stored")), \
                patch.object(payload_v3, "evaluation_payload", side_effect=AssertionError("v3 evaluation")), \
                patch.object(payload_v3, "bid_leaf_opening", side_effect=AssertionError("v3 leaf")), \
                patch.object(payload_v3, "award_private_opening", side_effect=AssertionError("v3 award")):
            self.client.force_authenticate(user=head)
            self.assertEqual(self.client.post(f"/api/projects/{project.pk}/approve/").status_code, 200)
            self.client.force_authenticate(user=admin)
            self.assertEqual(self.client.post(f"/api/projects/{project.pk}/publish/").status_code, 200)
            win = Bid.objects.create(project=project, supplier=self.supplier, amount=900, status=Bid.Status.QUALIFIED)
            Bid.objects.create(project=project, supplier=self.other, amount=950, status=Bid.Status.QUALIFIED)
            self.assertEqual(self.client.post(f"/api/bids/{win.pk}/select-winner/").status_code, 200)
        self.assertFalse(CommitmentOpening.objects.exists())
        anchors = BlockchainAnchor.objects.filter(entity_ref=project.code)
        self.assertIn("EVALUATION_COMPLETED", set(anchors.values_list("stage", flat=True)))
        for anchor in anchors:
            self.assertEqual(anchor.payload["v"], 2)
            self.assertNotIn("kind", anchor.payload)
        self.assertEqual(blockchain.PAYLOAD_VERSION, 2)
        self.assertIs(blockchain.PAYLOAD_V3_ENABLED, False)
        self.assertEqual(self.bid.commitment_salt, "")   # v2 salts untouched (Decision C)


class CommitmentStartupMatrixTests(APITestCase):
    """Phase 3 review: a real process through the gunicorn entry point, for each
    combination of the flag and the keys. Setup never connects to a database."""

    def _start(self, **settings_env):
        import os
        import subprocess
        import sys
        from pathlib import Path
        from django.conf import settings
        backend = Path(settings.BASE_DIR)
        env = {**os.environ, "DB_HOST": "", "DJANGO_SETTINGS_MODULE": "config.settings", "PYTHONPATH": str(backend),
               "PYTHONIOENCODING": "utf-8", "PAYLOAD_V3_ENABLED": "", "COMMITMENT_KEY": "", "COMMITMENT_OLD_KEYS": "",
               **settings_env}
        return subprocess.run([sys.executable, "-c", "import config.wsgi; print('STARTED')"],
                              cwd=backend, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)

    def test_v3_on_is_refused_with_every_key_state(self):
        good = throwaway_key()
        cases = {
            "no key": ({}, "COMMITMENT_KEY is not set"),
            "blank key": ({"COMMITMENT_KEY": "   "}, "COMMITMENT_KEY is not set"),
            "invalid key": ({"COMMITMENT_KEY": "invalid-key-value"}, "COMMITMENT_KEY is not a valid Fernet key"),
            "invalid old key": ({"COMMITMENT_KEY": good, "COMMITMENT_OLD_KEYS": "invalid-key-value"},
                                "COMMITMENT_OLD_KEYS entry 1 is not a valid Fernet key"),
            "valid key": ({"COMMITMENT_KEY": good}, "PAYLOAD_V3_ENABLED is on"),
        }
        for name, (env, message) in cases.items():
            with self.subTest(name):
                out = self._start(PAYLOAD_V3_ENABLED="true", **env)
                text = out.stdout + out.stderr
                self.assertNotEqual(out.returncode, 0)
                self.assertNotIn("STARTED", out.stdout)
                self.assertIn("ImproperlyConfigured", out.stderr)
                self.assertIn(message, out.stderr)
                self.assertNotIn("invalid-key-value", text)
                self.assertNotIn(good, text)

    def test_any_spelling_of_true_is_refused(self):
        self.assertNotEqual(self._start(PAYLOAD_V3_ENABLED=" TRUE ").returncode, 0)

    def test_v3_off_starts_with_every_key_state_and_reports_a_bad_key(self):
        good = throwaway_key()
        self.assertIn("STARTED", self._start().stdout)
        for value in ("false", "1", "yes"):
            with self.subTest(flag=value):
                self.assertIn("STARTED", self._start(PAYLOAD_V3_ENABLED=value).stdout)
        valid = self._start(COMMITMENT_KEY=good)
        self.assertIn("STARTED", valid.stdout)
        self.assertNotIn(good, valid.stdout + valid.stderr)
        invalid = self._start(COMMITMENT_KEY="invalid-key-value")
        self.assertEqual(invalid.returncode, 0, invalid.stderr)
        self.assertIn("STARTED", invalid.stdout)
        self.assertIn("COMMITMENT_KEY is not a valid Fernet key", invalid.stderr)
        self.assertNotIn("invalid-key-value", invalid.stdout + invalid.stderr)

    def test_a_flag_spelled_any_other_way_writes_v2(self):
        with patch.dict("os.environ", {"PAYLOAD_V3_ENABLED": "1"}):
            self.assertFalse(blockchain._env_flag("PAYLOAD_V3_ENABLED", "False"))

    def test_a_valid_current_key_with_an_invalid_old_key_stores_nothing(self):
        with override_settings(COMMITMENT_KEY=throwaway_key(), COMMITMENT_OLD_KEYS="invalid-key-value"):
            with self.assertRaises(openings.OpeningsNotConfigured) as caught:
                openings._keyring()
        self.assertNotIn("invalid-key-value", str(caught.exception))


class AwardTimeSemanticsTests(APITestCase):
    """Phase 3 review: what the committed `awarded_at` means. 17:30 UTC on 3 Nov
    is 01:30 on 4 Nov in Manila, so this time is the one where the two dates differ."""

    AT = datetime(2026, 11, 3, 17, 30, 0, 654321, tzinfo=dt_timezone.utc)

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.win = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=900,
                                      status=Bid.Status.QUALIFIED)
        self.client.force_authenticate(user=self.admin)
        with patch("django.utils.timezone.now", return_value=self.AT):
            self.assertEqual(self.client.post(f"/api/bids/{self.win.pk}/select-winner/").status_code, 200)
        self.project.refresh_from_db()

    def _opening(self):
        award = Award.objects.select_related("project").get(project=self.project)
        return payload_v3.award_private_opening(award, "ab" * 32)

    def test_the_commitment_holds_the_exact_instant_in_utc_after_a_database_round_trip(self):
        self.assertEqual(self.project.awarded_at, self.AT)
        self.assertEqual(self._opening()["awarded_at"], "2026-11-03T17:30:00.654321+00:00")

    def test_the_text_is_the_same_whatever_zone_the_server_renders_in(self):
        from django.utils.timezone import override as tz_override
        with tz_override("America/New_York"):
            self.assertEqual(self._opening()["awarded_at"], "2026-11-03T17:30:00.654321+00:00")

    def test_a_time_held_in_another_zone_is_converted_to_utc(self):
        from zoneinfo import ZoneInfo
        manila = self.AT.astimezone(ZoneInfo("Asia/Manila"))
        self.assertEqual(payload_v3.iso_utc(manila), "2026-11-03T17:30:00.654321+00:00")

    def test_late_utc_awards_fall_on_the_next_manila_date(self):
        from datetime import date
        self.assertEqual(self.project.awarded_at.date(), date(2026, 11, 3))
        self.assertEqual(timezone.localdate(self.project.awarded_at), date(2026, 11, 4))

    def test_a_re_award_is_refused_and_the_time_never_moves(self):
        rival = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=950,
                                   status=Bid.Status.QUALIFIED)
        later = self.AT + timedelta(days=2)
        with patch("django.utils.timezone.now", return_value=later):
            res = self.client.post(f"/api/bids/{rival.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.awarded_at, self.AT)

    def test_it_cannot_be_written_through_the_api(self):
        self.assertIn("awarded_at", ProjectSerializer.Meta.read_only_fields)

    def test_a_naive_datetime_or_a_bare_date_is_refused_never_guessed(self):
        from datetime import date
        for value in (datetime(2026, 11, 3, 17, 30), date(2026, 11, 3), "2026-11-03"):
            with self.subTest(repr(value)):
                with self.assertRaises(NonCanonicalPayload):
                    payload_v3.iso_utc(value)

    def test_a_whole_second_still_matches_the_schema(self):
        whole = datetime(2026, 11, 3, 17, 30, tzinfo=dt_timezone.utc)
        self.assertEqual(payload_v3.iso_utc(whole), "2026-11-03T17:30:00+00:00")
        self.project.awarded_at = whole
        self.project.save(update_fields=["awarded_at"])
        payload_v3.validate_opening(self._opening())


class CommitmentDocumentationTests(APITestCase):
    """The docs name the keys and hold no value, and v3 is not switched on anywhere."""

    def _read(self, relative):
        from pathlib import Path
        from django.conf import settings
        return (Path(settings.BASE_DIR).parent / relative).read_text(encoding="utf-8")

    def test_every_required_document_names_the_key_and_none_holds_a_value(self):
        import re
        fernet_like = re.compile(r"[A-Za-z0-9_-]{43}=")
        for relative in ("backend/.env.example", "render.yaml", "SECURITY.md"):
            with self.subTest(relative):
                text = self._read(relative)
                self.assertIn("COMMITMENT_KEY", text)
                self.assertIsNone(fernet_like.search(text))
        # Excluded from git on this machine, so absent from a clean checkout.
        from pathlib import Path
        from django.conf import settings
        for relative in ("knowledge.md", "AGENTS.md"):
            path = Path(settings.BASE_DIR).parent / relative
            if path.exists():
                self.assertIsNone(fernet_like.search(path.read_text(encoding="utf-8")), relative)
        example = self._read("backend/.env.example")
        self.assertRegex(example, r"(?m)^COMMITMENT_KEY=\r?$")
        self.assertRegex(example, r"(?m)^COMMITMENT_OLD_KEYS=\r?$")

    def test_no_deployment_file_turns_v3_on_or_sets_the_key(self):
        import re
        render = self._read("render.yaml")
        self.assertIsNone(re.search(r"(?m)^\s*- key: (PAYLOAD_V3_ENABLED|COMMITMENT_KEY|COMMITMENT_OLD_KEYS)", render))
        self.assertIsNone(re.search(r"(?m)^PAYLOAD_V3_ENABLED", self._read("backend/.env.example")))

    def test_decision_a_is_described_as_provisional(self):
        self.assertIn("WORKING ASSUMPTION", self._read("backend/procurement/payload_v3.py"))

    def test_the_disclosure_policy_is_documented_with_its_open_gaps(self):
        security = self._read("SECURITY.md")
        self.assertIn("### Award disclosure policy", security)
        self.assertIn("**Working policy, and provisional.**", security)
        self.assertIn("**Blockchain timing can't be hidden.**", security)
        self.assertIn("**Open gaps.**", security)

    def test_the_phase_6_plan_is_in_a_tracked_document_and_marked_unbuilt(self):
        security = self._read("SECURITY.md")
        self.assertIn("**Not implemented.**", security)
        for requirement in ("Persist before signing", "Failure indicator", "Recovery", "Duplicate prevention"):
            self.assertIn(requirement, security)
        self.assertNotIn("(knowledge.md)", security)


# ── Stage 5 Phase 4: the v3 reader, outcomes and historical documents ────────
# Every v3 anchor here is synthetic: the writer is switched on in-process only, or
# the row is built by hand. Nothing is signed or sent.

CONFIRMED_TX = "0x" + "ab" * 32


class V3ReaderCase(ProjectDocumentCase):
    def v3_project(self, purchase_request=b"pr one"):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            return self.file_project(purchase_request)

    def anchor_of(self, project, stage="SUBMITTED"):
        return BlockchainAnchor.objects.get(entity_ref=project.code, stage=stage)

    def rewrite(self, anchor, change):
        """The same anchor with its payload changed AND its hash recomputed, as if
        the row and the chain both held it: the schema is then the only defence."""
        payload = json.loads(json.dumps(anchor.payload))
        change(payload)
        anchor.payload = payload
        anchor.data_hash = hash_payload(payload)
        return anchor

    def confirmed(self, anchor):
        anchor.tx_hash = CONFIRMED_TX
        anchor.chain_status = BlockchainAnchor.ChainStatus.CONFIRMED
        return anchor

    @staticmethod
    def overwrite(row, body):
        with open(row.file.path, "wb") as handle:
            handle.write(body)


class V3ProjectStageReaderTests(V3ReaderCase):
    def test_a_genuine_project_stage_matches_with_its_flag_off(self):
        anchor = self.anchor_of(self.v3_project())
        self.assertIs(blockchain.PAYLOAD_V3_ENABLED, False)
        result = verify_anchor(anchor, deep=True)
        self.assertEqual((result["status"], result["record"], result["document"]), ("match", "match", "match"))
        self.assertEqual(result["completeness"]["status"], "complete")
        self.assertEqual(result["document_evidence"]["state"], "match")
        self.assertEqual(len(result["document_evidence"]["entries"]), 5)

    def test_an_edited_stored_payload_is_a_mismatch(self):
        anchor = self.anchor_of(self.v3_project())
        anchor.payload["budget"] = "1.00"
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def test_a_v2_anchor_relabelled_as_v3_is_a_mismatch(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        anchor.payload["v"] = 3
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def test_an_edited_live_record_is_a_mismatch(self):
        project = self.v3_project()
        anchor = self.anchor_of(project)
        Project.objects.filter(pk=project.pk).update(budget=1)
        result = verify_anchor(anchor)
        self.assertEqual((result["status"], result["record"]), ("mismatch", "mismatch"))

    def test_a_live_record_outside_the_schema_is_a_mismatch_not_a_crash(self):
        project = self.v3_project()
        anchor = self.anchor_of(project)
        Project.objects.filter(pk=project.pk).update(budget=-1)
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def test_a_payload_filed_under_another_stage_is_a_mismatch(self):
        anchor = self.anchor_of(self.v3_project())
        anchor.stage = "BIDDING_OPEN"
        self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def test_a_payload_outside_the_schema_is_unavailable_never_altered(self):
        changes = {
            "an extra key": lambda p: p.update(extra="x"),
            "a missing key": lambda p: p.pop("category"),
            "a null": lambda p: p.update(category=None),
            "a boolean": lambda p: p.update(bidding_period_days=True),
            "a float": lambda p: p.update(bidding_period_days=1.5),
            "uppercase in a hash": lambda p: p["documents"]["purchase_request"].update(sha256="0x" + "AB" * 32),
            "a sixth document": lambda p: p["documents"].update(sixth={"state": "absent", "sha256": "", "version": 0}),
            "a missing document": lambda p: p["documents"].pop("terms_of_reference"),
            "an unknown state": lambda p: p["documents"]["purchase_request"].update(state="lost"),
            "a hash on an absent file": lambda p: p["documents"]["terms_of_reference"].update(
                state="absent", version=0),
            "the wrong evidence key": lambda p: p.update(document_key="terms_of_reference"),
            "a time zone other than UTC": lambda p: p.update(created_at="2026-11-04T08:00:00+08:00"),
        }
        for name, change in changes.items():
            with self.subTest(name):
                anchor = self.rewrite(self.anchor_of(self.project_once()), change)
                result = verify_anchor(anchor, deep=True)
                self.assertEqual((result["status"], result.get("reason")), ("unavailable", "schema_invalid"))
                self.assertEqual(result["completeness"]["status"], "unknown")

    def project_once(self):
        if not hasattr(self, "_project"):
            self._project = self.v3_project()
        return self._project

    def test_kinds_this_server_cannot_read_are_unavailable_never_altered(self):
        for kind in ("award-document/3", "bid-leaf/3", "award-private/3", "project-stage/4", "", None):
            with self.subTest(kind):
                anchor = self.rewrite(self.anchor_of(self.project_once()), lambda p, k=kind: p.update(kind=k))
                result = verify_anchor(anchor)
                self.assertEqual((result["status"], result.get("reason")), ("unavailable", "unsupported_kind"))

    def test_a_future_version_is_still_unsupported(self):
        anchor = self.rewrite(self.anchor_of(self.project_once()), lambda p: p.update(v=4))
        result = verify_anchor(anchor)
        self.assertEqual((result["status"], result.get("reason")), ("unavailable", "unsupported_version"))


class V3CompletenessTests(V3ReaderCase):
    def manifest_anchor(self, **files):
        project = self.legacy_project(**files)
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            return project, blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)

    ALL = {"purchase_request": b"a", "technical_specifications": b"b", "approved_budget_document": b"c",
           "bid_evaluation_criteria": b"d"}

    def test_one_absent_document_reads_four_of_five_and_names_it(self):
        _, anchor = self.manifest_anchor(**self.ALL)
        result = verify_anchor(anchor)
        self.assertEqual(result["status"], "match")
        self.assertEqual(result["completeness"]["label"], "INCOMPLETE: 4 of 5 present")
        self.assertEqual(result["completeness"]["absent"], ["terms_of_reference"])

    def test_unreadable_takes_precedence_over_absent(self):
        project = self.legacy_project(purchase_request=b"a")
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True), \
                patch("django.db.models.fields.files.FieldFile.open", side_effect=OSError("storage down")):
            anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        result = verify_anchor(anchor)
        self.assertEqual(result["completeness"]["status"], "unreadable_when_recorded")
        self.assertEqual(result["completeness"]["label"], "INCOMPLETE: UNREADABLE WHEN RECORDED")
        self.assertEqual(result["completeness"]["unreadable"], ["purchase_request"])

    def test_a_file_gone_from_storage_today_never_changes_recorded_completeness(self):
        project = self.v3_project()
        anchor = self.anchor_of(project)
        default_storage.delete(self.versions(project, "terms_of_reference")[0].file.name)
        result = verify_anchor(anchor, deep=True)
        self.assertEqual(result["completeness"]["status"], "complete")
        by_key = {e["key"]: e["state"] for e in result["document_evidence"]["entries"]}
        self.assertEqual(by_key["terms_of_reference"], "file_missing")
        self.assertEqual(result["document"], "unavailable")

    def test_v1_and_v2_are_not_recorded_and_evaluation_is_not_applicable(self):
        from .payload_v3_reader import completeness
        self.assertEqual(completeness({"v": 2, "stage": "SUBMITTED"})["status"], "not_recorded")
        self.assertEqual(completeness({"stage": "SUBMITTED"})["status"], "not_recorded")
        self.assertEqual(completeness({"v": 3, "kind": "evaluation/3"})["status"], "not_applicable")
        self.assertEqual(completeness({})["status"], "unknown")
        self.assertEqual(completeness(["not", "an", "object"])["status"], "unknown")
        self.assertEqual(completeness({"v": True})["status"], "unknown")

    def test_the_admin_dashboard_counts_incomplete_records_separately(self):
        self.manifest_anchor(**self.ALL)
        self.v3_project()
        self.client.force_authenticate(user=self.admin)
        res = self.client.get("/api/dashboard/admin-summary/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["chain"]["incomplete"], 1)


class V3EvaluationReaderTests(CommitmentOpeningCase):
    def _result(self, anchor, **kwargs):
        return verify_anchor(anchor, **kwargs)

    def test_a_genuine_evaluation_matches_and_its_openings_check_out(self):
        anchor, _, _ = self.evaluation()
        result = self._result(anchor)
        self.assertEqual((result["status"], result["openings"]), ("match", "match"))
        self.assertEqual(result["completeness"]["status"], "not_applicable")

    def test_a_re_priced_bid_is_a_mismatch(self):
        anchor, _, _ = self.evaluation()
        Bid.objects.filter(pk=self.bid.pk).update(amount=1)
        self.assertEqual(self._result(anchor)["status"], "mismatch")

    def test_a_re_graded_bid_is_a_mismatch(self):
        anchor, _, _ = self.evaluation()
        Bid.objects.filter(pk=self.bid.pk).update(status=Bid.Status.WINNER)
        self.assertEqual(self._result(anchor)["status"], "mismatch")

    def test_an_added_bid_is_a_mismatch_even_with_no_key(self):
        anchor, _, _ = self.evaluation()
        Bid.objects.create(project=self.project, supplier=make_supplier(), amount=1)
        self.assertEqual(self._result(anchor)["status"], "mismatch")
        with override_settings(COMMITMENT_KEY=throwaway_key()):
            self.assertEqual(self._result(anchor)["status"], "mismatch")

    def test_a_lost_key_is_opening_unavailable_and_public_integrity_stands(self):
        anchor, _, _ = self.evaluation()
        with override_settings(COMMITMENT_KEY=throwaway_key()):
            result = self._result(anchor)
        self.assertEqual((result["status"], result["openings"]), ("match", "unavailable"))

    def test_a_ciphertext_swapped_between_leaves_is_an_opening_mismatch(self):
        anchor, rows, _ = self.evaluation()
        CommitmentOpening.rewrap(rows[0].pk, rows[0].ciphertext, rows[1].ciphertext, rows[0].key_fingerprint)
        self.assertEqual(self._result(anchor)["openings"], "mismatch")

    def test_a_leaf_with_no_stored_opening_is_incomplete(self):
        first, second = self.leaf(self.bid), self.leaf(self.other_bid)
        anchor = self.anchor_for(payload_v3.evaluation_payload(
            self.project, [hash_payload(first), hash_payload(second)]))
        openings.store_opening(anchor, self.bid.id, first, self.supplier)
        self.assertEqual(self._result(anchor)["openings"], "incomplete")

    def test_an_evaluation_outside_the_schema_is_unavailable(self):
        anchor, _, _ = self.evaluation()
        for name, change in {
            "wrong count": lambda p: p.update(bid_count=9),
            "unsorted": lambda p: p["leaves"].reverse(),
            "duplicate": lambda p: p["leaves"].__setitem__(1, p["leaves"][0]),
            "bad leaf": lambda p: p["leaves"].__setitem__(0, "not a hash"),
            "extra key": lambda p: p.update(extra=1),
            "other stage": lambda p: p.update(stage="AWARDED"),
        }.items():
            with self.subTest(name):
                payload = json.loads(json.dumps(anchor.payload))
                change(payload)
                forged = BlockchainAnchor(entity_type=anchor.entity_type, entity_ref=anchor.entity_ref,
                                          entity_id=anchor.entity_id, stage=anchor.stage,
                                          data_hash=hash_payload(payload), payload=payload)
                result = self._result(forged)
                self.assertEqual((result["status"], result.get("reason")), ("unavailable", "schema_invalid"))

    def test_the_result_never_holds_a_private_value_or_the_bid_count(self):
        anchor, _, (first, second) = self.evaluation()
        body = json.dumps(self._result(anchor, deep=True), default=str)
        for secret in (first["salt"], second["salt"], "900.00", "950.00", "bid_count", "supplier_id"):
            self.assertNotIn(secret, body)
        self.assertNotIn("leaves", body)

    def test_a_deep_check_reports_one_entry_however_many_bids_there_are(self):
        doc = document_pdf(b"quote")
        self.bid.quotation_document = doc
        self.bid.save()
        anchor_hash = hash_file(self.bid.quotation_document)
        first = payload_v3.bid_leaf_opening(self.bid, anchor_hash, openings.new_salt())
        second = self.leaf(self.other_bid)
        anchor = self.anchor_for(payload_v3.evaluation_payload(
            self.project, [hash_payload(first), hash_payload(second)]))
        openings.store_opening(anchor, self.bid.id, first, self.supplier)
        openings.store_opening(anchor, self.other_bid.id, second, self.other)
        evidence = self._result(anchor, deep=True)["document_evidence"]
        self.assertEqual((evidence["state"], len(evidence["entries"])), ("match", 1))
        self.assertEqual(evidence["entries"][0]["key"], "bid_quotations")


class HistoricalDocumentEvidenceTests(V3ReaderCase):
    def _evidence(self, anchor, key="purchase_request"):
        result = verify_anchor(anchor, deep=True)
        entry = next(e for e in result["document_evidence"]["entries"] if e["key"] == key)
        return result, entry

    def test_each_stage_checks_the_version_it_recorded_not_the_latest(self):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            project = self.file_project(b"first")
            self.revise(project, b"second")
        submitted = self.anchor_of(project)
        revision = self.anchor_of(project, "REVISION_REQUESTED")
        result, entry = self._evidence(submitted)
        self.assertEqual(result["status"], "match")
        self.assertEqual((entry["version"], entry["state"]), (1, "match"))
        self.assertEqual(self._evidence(revision)[1]["version"], 1)
        self.assertEqual(project.purchase_request.name, self.versions(project)[1].file.name)

    def test_altered_kept_bytes_are_a_document_mismatch_naming_the_key_and_version(self):
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            project = self.file_project(b"first")
            self.revise(project, b"second")
        self.overwrite(self.versions(project)[0], b"forged")
        result, entry = self._evidence(self.anchor_of(project))
        self.assertEqual((result["status"], result["document"]), ("mismatch", "mismatch"))
        self.assertEqual((entry["key"], entry["version"], entry["state"]), ("purchase_request", 1, "mismatch"))

    def test_a_version_never_kept_is_absent_not_a_mismatch(self):
        anchor = self.rewrite(self.anchor_of(self.v3_project()),
                              lambda p: p["documents"]["terms_of_reference"].update(version=9))
        result, entry = self._evidence(anchor, "terms_of_reference")
        self.assertEqual(entry["state"], "version_absent")
        self.assertEqual((result["status"], result["document"]), ("unavailable", "unavailable"))

    def test_a_file_gone_from_storage_is_missing_not_a_mismatch(self):
        project = self.v3_project()
        default_storage.delete(self.versions(project)[0].file.name)
        result, entry = self._evidence(self.anchor_of(project))
        self.assertEqual(entry["state"], "file_missing")
        self.assertEqual(result["status"], "unavailable")

    def test_an_unreadable_file_is_unreadable_not_a_mismatch(self):
        anchor = self.anchor_of(self.v3_project())
        with patch("django.db.models.fields.files.FieldFile.chunks", side_effect=ValueError("corrupt")):
            result, entry = self._evidence(anchor)
        self.assertEqual(entry["state"], "file_unreadable")
        self.assertEqual(result["status"], "unavailable")

    def test_inaccessible_storage_is_its_own_state_when_opening_or_reading(self):
        anchor = self.anchor_of(self.v3_project())
        with patch("django.db.models.fields.files.FieldFile.open", side_effect=OSError("storage down")):
            self.assertEqual(self._evidence(anchor)[1]["state"], "storage_inaccessible")
        with patch("django.db.models.fields.files.FieldFile.chunks", side_effect=PermissionError("403")):
            self.assertEqual(self._evidence(anchor)[1]["state"], "storage_inaccessible")

    def test_a_current_file_in_no_recorded_version_is_called_out(self):
        project = self.v3_project()
        anchor = self.anchor_of(project)
        project.purchase_request = document_pdf(b"swapped in")
        project.save()
        result, entry = self._evidence(anchor)
        self.assertEqual((entry["state"], entry["current_file"]), ("match", "current_file_untracked"))
        self.assertEqual(result["document_evidence"]["state"], "current_file_untracked")
        self.assertEqual(result["document"], "unavailable")

    def test_documents_absent_when_recorded_are_facts_not_failures(self):
        project = self.legacy_project(purchase_request=b"a")
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        result, entry = self._evidence(anchor, "terms_of_reference")
        self.assertEqual(entry["state"], "absent_when_recorded")
        self.assertEqual((result["status"], result["document_evidence"]["state"]), ("match", "match"))

    def test_without_deep_nothing_is_read_from_storage(self):
        anchor = self.anchor_of(self.v3_project())
        with patch("django.db.models.fields.files.FieldFile.open", side_effect=AssertionError("read")):
            result = verify_anchor(anchor)
        self.assertEqual(result["document_evidence"], {"checked": False, "state": "not_checked", "entries": []})

    def test_results_hold_no_stored_file_name(self):
        project = self.v3_project()
        result = verify_anchor(self.anchor_of(project), deep=True)
        self.assertNotIn(self.versions(project)[0].file.name, json.dumps(result, default=str))

    # v1 and v2: `document` keeps its meaning, evidence adds the version

    def test_a_v2_anchor_keeps_its_mismatch_and_evidence_finds_the_kept_version(self):
        project = self.file_project(b"first")
        self.revise(project, b"second")
        result, entry = self._evidence(self.anchor_of(project))
        self.assertEqual((result["status"], result["document"]), ("mismatch", "mismatch"))
        self.assertEqual((entry["version"], entry["state"]), (1, "match"))

    def test_a_v2_file_replaced_with_no_history_is_an_absent_version(self):
        project = self.legacy_project(purchase_request=b"first")
        anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        project.purchase_request = document_pdf(b"second")
        project.save()
        result, entry = self._evidence(anchor)
        self.assertEqual(result["document"], "mismatch")
        self.assertEqual(entry["state"], "version_absent")


class AwardDocumentEvidenceTests(ProjectDocumentCase):
    """Award documents already keep versions: a superseded issue is read by ITS row."""

    def setUp(self):
        super().setUp()
        project = make_project(status=Project.Status.PUBLISHED)
        win = Bid.objects.create(project=project, supplier=make_supplier(), amount=900, status=Bid.Status.QUALIFIED)
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/bids/{win.pk}/select-winner/").status_code, 200)
        self.award = Award.objects.get()
        for body in (b"%PDF-1.4 first", b"%PDF-1.4 second"):
            res = self.client.post(f"/api/awards/{self.award.pk}/documents/", {
                "key": "notice_of_award",
                "file": SimpleUploadedFile("noa.pdf", body, content_type="application/pdf"),
            }, format="multipart")
            self.assertEqual(res.status_code, 200, res.data)
        self.first, self.second = BlockchainAnchor.objects.filter(stage="NOA_ISSUED").order_by("id")

    def _version(self, anchor):
        return AwardDocumentVersion.objects.get(anchor=anchor)

    def test_a_superseded_issue_stays_superseded_and_is_checked_against_its_own_file(self):
        result = verify_anchor(self.first, deep=True)
        self.assertEqual((result["status"], result["document"]), ("superseded", "skipped"))
        self.assertEqual(result["document_evidence"]["state"], "match")
        self.assertEqual(result["document_evidence"]["entries"][0]["version"], 1)

    def test_altered_bytes_of_a_superseded_issue_are_found(self):
        version = self._version(self.first)
        with open(version.file.path, "wb") as handle:
            handle.write(b"forged")
        self.assertEqual(verify_anchor(self.first, deep=True)["document_evidence"]["state"], "mismatch")

    def test_a_superseded_issue_from_before_history_is_an_absent_version(self):
        AwardDocumentVersion.objects.filter(anchor=self.first).delete()
        self.assertEqual(verify_anchor(self.first, deep=True)["document_evidence"]["state"], "version_absent")


class VerificationOutcomeTests(V3ReaderCase):
    """Five outcomes, kept apart, in both the result and the API."""

    def _v2(self):
        project = self.file_project()
        return project, self.anchor_of(project)

    def _summary(self, anchor, *, deep=False):
        from .verification import summarize
        return summarize(anchor, verify_anchor(anchor, deep=deep))

    def _check(self, summary, key):
        return next(c for c in summary["checked"] if c["key"] == key)

    def test_verified_needs_every_check_and_a_confirmed_transaction(self):
        _, anchor = self._v2()
        summary = self._summary(self.confirmed(anchor), deep=True)
        self.assertEqual((summary["outcome"], summary["label"]), ("verified", "Verified"))
        self.assertEqual(self._check(summary, "transaction")["status"], "pass")
        self.assertEqual(self._check(summary, "document")["status"], "pass")

    def test_a_transaction_hash_alone_is_never_verified(self):
        _, anchor = self._v2()
        anchor.tx_hash = CONFIRMED_TX
        summary = self._summary(anchor)
        self.assertEqual((summary["outcome"], summary["label"]),
                         ("unconfirmed", "Unavailable or incomplete evidence"))
        self.assertIn("A hash alone proves nothing", self._check(summary, "transaction")["detail"])

    def test_mismatch(self):
        project, anchor = self._v2()
        Project.objects.filter(pk=project.pk).update(budget=1)
        self.assertEqual(self._summary(self.confirmed(anchor))["outcome"], "hash_mismatch")

    def test_missing_evidence(self):
        project, anchor = self._v2()
        cases = {
            "no transaction": anchor,
            "no payload": BlockchainAnchor(entity_type=anchor.entity_type, entity_ref=anchor.entity_ref,
                                           entity_id=anchor.entity_id, stage=anchor.stage,
                                           data_hash=anchor.data_hash, payload={},
                                           tx_hash=CONFIRMED_TX, chain_status="confirmed"),
            "record gone": BlockchainAnchor(entity_type=anchor.entity_type, entity_ref=anchor.entity_ref,
                                            entity_id="999999", stage=anchor.stage, data_hash=anchor.data_hash,
                                            payload=anchor.payload, tx_hash=CONFIRMED_TX, chain_status="confirmed"),
        }
        for name, case in cases.items():
            with self.subTest(name):
                self.assertEqual(self._summary(case)["label"], "Missing evidence")

    def test_a_version_or_file_gone_is_missing_and_unreadable_storage_is_unavailable(self):
        project = self.v3_project()
        anchor = self.confirmed(self.anchor_of(project))
        with patch("django.db.models.fields.files.FieldFile.open", side_effect=OSError("down")):
            self.assertEqual(self._summary(anchor, deep=True)["outcome"], "unconfirmed")
        default_storage.delete(self.versions(project)[0].file.name)
        self.assertEqual(self._summary(anchor, deep=True)["outcome"], "not_found")

    def test_unavailable_for_an_unsupported_version(self):
        _, anchor = self._v2()
        anchor = self.confirmed(self.rewrite(anchor, lambda p: p.update(v=4)))
        self.assertEqual(self._summary(anchor)["outcome"], "unconfirmed")

    def test_invalid_transaction_is_never_collapsed_into_a_mismatch(self):
        for chain_status in ("mismatch", "reverted", "dropped"):
            with self.subTest(chain_status):
                _, anchor = self._v2()
                anchor.tx_hash, anchor.chain_status = CONFIRMED_TX, chain_status
                summary = self._summary(anchor)
                self.assertEqual((summary["outcome"], summary["label"]), ("invalid_tx", "Invalid transaction"))
                self.assertEqual(self._check(summary, "fingerprint")["status"], "pass")
        _, anchor = self._v2()
        anchor.tx_hash = "0xnot-a-hash"
        self.assertEqual(self._summary(anchor)["outcome"], "invalid_tx")

    def test_both_failures_are_shown_when_a_record_is_altered_and_its_transaction_invalid(self):
        project, anchor = self._v2()
        anchor.tx_hash, anchor.chain_status = CONFIRMED_TX, "mismatch"
        Project.objects.filter(pk=project.pk).update(budget=1)
        summary = self._summary(anchor)
        self.assertEqual(summary["outcome"], "hash_mismatch")
        self.assertEqual(self._check(summary, "transaction")["status"], "fail")

    def test_a_legacy_record_says_what_was_not_checked(self):
        _, anchor = self._v2()
        summary = self._summary(self.confirmed(anchor))
        self.assertEqual(summary["headline"], "VERIFIED — LEGACY RECORD (v1 or v2)")
        self.assertTrue(any("five-document completeness was not checked" in u for u in summary["unverified"]))

    def test_a_complete_v3_record_has_no_legacy_note_and_says_files_were_not_read(self):
        summary = self._summary(self.confirmed(self.anchor_of(self.v3_project())))
        self.assertEqual((summary["outcome"], summary["headline"]),
                         ("verified", "RECORD MATCH — DOCUMENT NOT CHECKED BY THE SERVER"))
        self.assertIs(summary["green"], False)
        self.assertTrue(any("not re-read" in u for u in summary["unverified"]))

    def test_the_server_re_reading_its_own_copies_is_still_not_a_selected_document(self):
        summary = self._summary(self.confirmed(self.anchor_of(self.v3_project())), deep=True)
        self.assertEqual((summary["outcome"], summary["headline"]),
                         ("verified", "RECORD MATCH — KEPT DOCUMENTS RE-READ BY THE SERVER"))
        self.assertIs(summary["green"], False)
        self.assertEqual(summary["tone"], "info")

    def test_no_server_outcome_is_ever_green(self):
        project, anchor = self._v2()
        self.assertIs(self._summary(self.confirmed(anchor), deep=True)["green"], False)
        Project.objects.filter(pk=project.pk).update(budget=1)
        self.assertIs(self._summary(anchor)["green"], False)

    def test_an_incomplete_manifest_keeps_its_genuine_fingerprint_under_the_amber_outcome(self):
        project = self.legacy_project(
            purchase_request=b"a", technical_specifications=b"b", approved_budget_document=b"c",
            bid_evaluation_criteria=b"d")
        with patch.object(blockchain, "PAYLOAD_V3_ENABLED", True):
            anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        summary = self._summary(self.confirmed(anchor))
        self.assertEqual(summary["outcome"], "unconfirmed")
        self.assertEqual(summary["headline"],
                         "MATCH — INCOMPLETE EVIDENCE (4 of 5 present; missing: Terms of Reference (TOR))")
        self.assertNotIn("VERIFIED", summary["headline"].upper())
        self.assertEqual(summary["tone"], "warn")
        self.assertTrue(any("Terms of Reference" in u and "fingerprint is genuine" in u for u in summary["unverified"]))

    def test_an_unreadable_document_is_counted_and_named_without_the_word_verified(self):
        from .verification import incomplete_headline
        self.assertEqual(
            incomplete_headline({"present": 3, "total": 5, "absent": ["terms_of_reference"],
                                 "unreadable": ["purchase_request"]}),
            "MATCH — INCOMPLETE EVIDENCE (3 of 5 present; unreadable when recorded: Purchase Request (PR); "
            "missing: Terms of Reference (TOR))")

    def test_the_server_never_claims_the_browser_s_green(self):
        _, anchor = self._v2()
        summary = self._summary(self.confirmed(anchor))
        self.assertEqual((summary["tone"], summary["source"]), ("info", "server"))
        self.assertIn("independent check", summary["unverified"][0])


class LegacyRevisionHistoryTests(V3ReaderCase):
    """verify_anchor stays frozen for v1/v2. The version evidence stands beside it, and
    only supports a claim of tampering when the kept bytes themselves changed."""

    def _summary(self, anchor):
        from .verification import summarize
        return verify_anchor(anchor, deep=True), summarize(anchor, verify_anchor(anchor, deep=True))

    def test_a_normal_revision_keeps_its_mismatch_and_is_not_called_tampering(self):
        project = self.file_project(b"first")
        self.revise(project, b"second")
        integrity, summary = self._summary(self.confirmed(self.anchor_of(project)))
        self.assertEqual((integrity["status"], integrity["document"]), ("mismatch", "mismatch"))
        self.assertEqual(integrity["detail"], "The attached document has been replaced since it was recorded.")
        self.assertEqual(summary["outcome"], "hash_mismatch")
        history = summary["historical"]
        self.assertEqual((history["kind"], history["version"], history["tamper_indicated"]),
                         ("later_revision", 1, False))
        self.assertEqual(history["original_result"], "mismatch")
        self.assertEqual(history["original_detail"], integrity["detail"])
        self.assertIn("not evidence of tampering", history["explanation"])
        self.assertEqual(summary["tone"], "warn")
        self.assertIn("later revision", summary["headline"])

    def test_kept_bytes_that_changed_do_indicate_tampering(self):
        project = self.file_project(b"first")
        self.revise(project, b"second")
        self.overwrite(self.versions(project)[0], b"forged")
        _, summary = self._summary(self.confirmed(self.anchor_of(project)))
        self.assertEqual(summary["historical"]["kind"], "kept_version_differs")
        self.assertIs(summary["historical"]["tamper_indicated"], True)
        self.assertEqual(summary["tone"], "bad")

    def test_a_version_never_kept_accuses_nobody(self):
        project = self.legacy_project(purchase_request=b"first")
        anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        project.purchase_request = document_pdf(b"second")
        project.save()
        _, summary = self._summary(self.confirmed(anchor))
        self.assertEqual(summary["outcome"], "hash_mismatch")
        self.assertEqual(summary["historical"]["kind"], "version_not_kept")
        self.assertIs(summary["historical"]["tamper_indicated"], False)
        self.assertIn("can't show", summary["historical"]["explanation"])

    def test_an_edited_record_gets_no_softer_explanation(self):
        project = self.file_project(b"first")
        self.revise(project, b"second")
        Project.objects.filter(pk=project.pk).update(budget=1)
        _, summary = self._summary(self.confirmed(self.anchor_of(project)))
        self.assertIsNone(summary["historical"])
        self.assertEqual(summary["tone"], "bad")

    def test_without_the_deep_check_there_is_nothing_to_explain(self):
        from .verification import summarize
        project = self.file_project(b"first")
        self.revise(project, b"second")
        anchor = self.confirmed(self.anchor_of(project))
        self.assertIsNone(summarize(anchor, verify_anchor(anchor))["historical"])

    def test_a_v3_current_file_outside_history_stays_unconfirmed(self):
        from .verification import summarize
        project = self.v3_project()
        anchor = self.confirmed(self.anchor_of(project))
        project.purchase_request = document_pdf(b"swapped in")
        project.save()
        summary = summarize(anchor, verify_anchor(anchor, deep=True))
        self.assertEqual(summary["outcome"], "unconfirmed")
        self.assertIsNone(summary["historical"])

    def test_no_stored_payload_stays_a_frozen_mismatch_and_is_missing_evidence(self):
        from .record import _counts
        from .verification import summarize
        project = self.file_project(b"first")
        anchor = self.confirmed(self.anchor_of(project))
        anchor.payload = {}
        integrity = verify_anchor(anchor)
        self.assertEqual(integrity["status"], "mismatch")     # as at the baseline
        summary = summarize(anchor, integrity)
        self.assertEqual((summary["outcome"], summary["label"]), ("not_found", "Missing evidence"))
        row = {"integrity": integrity, "verification": summary, "verified_on_chain": True, "tx_hash": "x",
               "chain_status": "confirmed"}
        counts = _counts([row])
        self.assertEqual((counts["altered"], counts["payload_missing"], counts["document_differs"]), (1, 1, 0))

    def test_the_api_altered_count_is_unchanged_and_the_revision_is_counted_apart(self):
        project = self.file_project(b"first")
        self.revise(project, b"second")
        Project.objects.filter(pk=project.pk).update(status=Project.Status.PUBLISHED)
        self.client.force_authenticate(user=None)
        data = self.client.get(f"/api/public/procurement/{project.code}/anchors/", {"deep": 1}).data
        self.assertGreaterEqual(data["altered_count"], 1)
        self.client.force_authenticate(user=self.admin)
        counts = self.client.get(f"/api/projects/{project.pk}/record/", {"deep": 1}).data["blockchain"]["counts"]
        self.assertEqual(counts["altered"], data["altered_count"])
        self.assertEqual(counts["document_differs"], counts["altered"])


class V3ReaderIsReadOnlyTests(V3ReaderCase):
    def _snapshot(self):
        return (list(BlockchainAnchor.objects.order_by("id").values()),
                list(ProjectDocumentVersion.objects.order_by("id").values()),
                AuditLog.objects.count())

    def test_verifying_writes_nothing_and_sends_nothing(self):
        project = self.v3_project()
        anchor = self.anchor_of(project)
        before = self._snapshot()
        with patch.object(blockchain, "submit_anchor_server_side") as submit, \
                patch.object(blockchain, "record_anchor") as record, \
                patch.object(blockchain, "attach_transaction") as attach:
            verify_anchor(anchor, deep=True)
        for call in (submit, record, attach):
            call.assert_not_called()
        self.assertEqual(self._snapshot(), before)

    def test_the_new_modules_have_no_way_to_sign_or_submit(self):
        from pathlib import Path
        here = Path(blockchain.__file__).parent
        for name in ("payload_v3_reader.py", "document_evidence.py", "verification.py"):
            text = (here / name).read_text(encoding="utf-8")
            for word in ("web3", "submit_anchor", "sign_transaction", "send_raw", "attach_transaction",
                         "record_anchor", "store_opening", ".save(", ".create("):
                self.assertNotIn(word, text, f"{name}: {word}")

    def test_reading_v3_opens_no_path_to_writing_it(self):
        self.assertIs(blockchain.PAYLOAD_V3_ENABLED, False)
        self.assertEqual(blockchain.PAYLOAD_VERSION, 2)
        self.assertNotIn(3, blockchain.PAYLOAD_RULES)
        self.assertIn(3, blockchain.READ_ONLY_RULES)
        with self.assertRaisesMessage(ImproperlyConfigured, "no entry in PAYLOAD_RULES"):
            blockchain.check_writer_version(3, blockchain.PAYLOAD_RULES)
        project = make_project(status=Project.Status.PENDING_HEAD)
        anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        self.assertEqual(anchor.payload["v"], 2)

    def test_a_v3_evaluation_anchor_gives_no_receipt_until_openings_are_served(self):
        project = make_project()
        supplier = make_supplier()
        bid = Bid.objects.create(project=project, supplier=supplier, amount=900, commitment_salt="ab" * 32)
        payload = payload_v3.evaluation_payload(project, ["0x" + "11" * 32])
        BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT, entity_ref=project.code, entity_id=str(project.id),
            stage="EVALUATION_COMPLETED", data_hash=hash_payload(payload), payload=payload)
        self.assertIsNone(inclusion_receipt(bid))


class V3PublicPacketTests(V3ReaderCase):
    def _packet(self, project, anchor):
        return self.client.get(f"/api/public/procurement/{project.code}/anchors/{anchor.pk}/packet/")

    def _published(self):
        project = self.v3_project()
        Project.objects.filter(pk=project.pk).update(status=Project.Status.PUBLISHED)
        return project, self.anchor_of(project)

    def test_a_valid_project_stage_packet_is_public_with_its_manifest(self):
        project, anchor = self._published()
        self.client.force_authenticate(user=None)
        res = self._packet(project, anchor)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["payload_version"], 3)
        self.assertEqual(len(res.data["payload"]["documents"]), 5)

    def test_a_v3_payload_outside_the_schema_is_withheld(self):
        project, anchor = self._published()
        self.rewrite(anchor, lambda p: p.update(private_note="x"))
        anchor.save()
        self.client.force_authenticate(user=None)
        self.assertEqual(self._packet(project, anchor).status_code, 404)

    def test_a_v2_payload_holding_v3_keys_is_still_withheld(self):
        project = make_project(status=Project.Status.PUBLISHED)
        anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        self.rewrite(anchor, lambda p: p.update(documents={}))
        anchor.save()
        self.client.force_authenticate(user=None)
        self.assertEqual(self._packet(project, anchor).status_code, 404)

    def test_the_public_trail_shows_a_manifest_only_for_a_public_v3_stage(self):
        project, _ = self._published()
        self.client.force_authenticate(user=None)
        row = self.client.get(f"/api/public/procurement/{project.code}/anchors/").data["anchors"][0]
        self.assertEqual(set(row["document_manifest"]), set(PROCUREMENT_DOCUMENT_KEYS))
        v2 = make_project(status=Project.Status.PUBLISHED)
        blockchain.anchor_project(v2, BlockchainAnchor.Stage.SUBMITTED)
        row = self.client.get(f"/api/public/procurement/{v2.code}/anchors/").data["anchors"][0]
        self.assertIsNone(row["document_manifest"])


class LedgerAuditTests(APITestCase):
    """`audit_ledger`: the recovery check. The normal integrity check compares a
    record with the hash stored beside it in the same database, so an attacker
    who edits both passes it. Only the ledger's own copy is out of their reach."""

    LEDGER = "0x" + "12" * 20
    OWNER = "0x" + "0a" * 20
    SIGNER = "0x" + "11" * 20
    STRANGER = "0x" + "66" * 20

    def setUp(self):
        patcher = patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.rows = {}

    def _anchored(self, *, confirm=True):
        """A real SUBMITTED anchor, recorded on the fake ledger (and confirmed)."""
        project = make_project(status=Project.Status.PENDING_HEAD)
        anchor = blockchain.anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
        chain_id = len(self.rows)
        self.rows[chain_id] = (anchor.entity_type, anchor.entity_ref, anchor.stage,
                               anchor.data_hash, self.SIGNER, 1_762_000_000)
        if confirm:
            BlockchainAnchor.objects.filter(pk=anchor.pk).update(
                tx_hash="0x" + f"{chain_id + 1:02x}" * 32, actor_address=self.SIGNER,
                chain_status=BlockchainAnchor.ChainStatus.CONFIRMED, chain_anchor_id=chain_id,
                chain_contract=self.LEDGER)
        anchor.refresh_from_db()
        return project, anchor

    def _node(self, *, owner=None, restricted=False, chain_id=SEPOLIA):
        w3 = sepolia_node(state=self.rows, chain_id=chain_id)
        fns = w3.eth.contract.return_value.functions
        fns.total.return_value.call.return_value = len(self.rows)
        fns.owner.return_value.call.return_value = owner or self.OWNER
        fns.restricted.return_value.call.return_value = restricted
        return w3

    def _audit(self, *args, w3=None):
        out = io.StringIO()
        with patch("procurement.blockchain.web3_client", return_value=w3 or self._node()):
            try:
                call_command("audit_ledger", *args, stdout=out)
            except CommandError as exc:
                return out.getvalue(), exc
        return out.getvalue(), None

    def test_a_database_that_agrees_with_the_ledger_passes(self):
        self._anchored()
        self._anchored()
        out, err = self._audit("--expect-owner", self.OWNER)
        self.assertIsNone(err, out)
        self.assertIn("OK: the database agrees with the blockchain", out)
        self.assertIn("2 on-chain record(s), 2 database anchor(s)", out)

    def test_a_record_and_its_stored_hash_edited_together_is_caught(self):
        # The attack the normal check can't see: both database copies changed.
        project, anchor = self._anchored()
        Project.objects.filter(pk=project.pk).update(budget=1)
        project.refresh_from_db()
        payload, _ = blockchain.rebuild_payload(anchor, project, document_hash=anchor.document_hash)
        forged = blockchain.hash_payload(payload)
        BlockchainAnchor.objects.filter(pk=anchor.pk).update(data_hash=forged, payload=payload)
        anchor.refresh_from_db()
        self.assertEqual(verify_anchor(anchor)["status"], "match")   # the local check is fooled

        out, err = self._audit()
        self.assertIsNotNone(err)
        self.assertIn("no longer matches on-chain record 0", out)

    def test_an_edited_record_is_caught(self):
        project, _ = self._anchored()
        Project.objects.filter(pk=project.pk).update(budget=1)
        out, err = self._audit()
        self.assertIsNotNone(err)
        self.assertIn("altered since it was recorded", out)

    def test_a_deleted_anchored_record_is_caught(self):
        project, _ = self._anchored()
        Project.objects.filter(pk=project.pk).delete()
        out, err = self._audit()
        self.assertIsNotNone(err)
        self.assertIn("has been deleted", out)

    def test_an_on_chain_record_the_database_lost_is_reported(self):
        # A restore from an older backup, or a stolen signing key.
        self._anchored()
        self.rows[1] = ("PROJECT", "PC-LOST-0001", "SUBMITTED", "0x" + "ab" * 32, self.SIGNER, 1_762_000_500)
        out, err = self._audit()
        self.assertIsNotNone(err)
        self.assertIn("On-chain record 1 (PC-LOST-0001 SUBMITTED", out)

    def test_strangers_writing_to_an_open_ledger_is_only_a_warning(self):
        self._anchored()
        self.rows[1] = ("PROJECT", "PC-NOISE", "SUBMITTED", "0x" + "cd" * 32, self.STRANGER, 1)
        out, err = self._audit()
        self.assertIsNone(err, out)
        self.assertIn("1 on-chain record(s) were written by wallets this system", out)
        self.assertIn("The ledger is unrestricted", out)

    def test_strangers_writing_to_a_restricted_ledger_is_a_problem(self):
        self._anchored()
        self.rows[1] = ("PROJECT", "PC-NOISE", "SUBMITTED", "0x" + "cd" * 32, self.STRANGER, 1)
        _, err = self._audit(w3=self._node(restricted=True))
        self.assertIsNotNone(err)

    def test_an_unexpected_owner_is_a_problem(self):
        self._anchored()
        out, err = self._audit("--expect-owner", self.OWNER, w3=self._node(owner=self.STRANGER))
        self.assertIsNotNone(err)
        self.assertIn("Contract owner is", out)

    def test_an_unconfirmed_anchor_is_matched_by_its_content(self):
        self._anchored(confirm=False)
        out, err = self._audit()
        self.assertIsNone(err, out)

    def test_an_unreachable_or_wrong_network_checks_nothing(self):
        self._anchored()
        with patch("procurement.blockchain.network_check", return_value=(None, None)):
            _, err = self._audit()
        self.assertIn("Could not reach", str(err))
        _, err = self._audit(w3=self._node(chain_id=1))
        self.assertIn("not 11155111", str(err))

    def test_it_changes_nothing(self):
        project, _ = self._anchored()
        Project.objects.filter(pk=project.pk).update(budget=1)
        before = list(BlockchainAnchor.objects.values())
        logs = AuditLog.objects.count()
        self._audit()
        self.assertEqual(list(BlockchainAnchor.objects.values()), before)
        self.assertEqual(AuditLog.objects.count(), logs)

    def test_the_snapshot_holds_hashes_only_and_a_checksum(self):
        self._anchored()
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        out, err = self._audit("--snapshot", folder)
        self.assertIsNone(err, out)
        [name] = [n for n in os.listdir(folder) if n.endswith(".json")]
        with open(os.path.join(folder, name), "rb") as f:
            data = f.read()
        with open(os.path.join(folder, name + ".sha256"), encoding="ascii") as f:
            self.assertEqual(f.read().split()[0], hashlib.sha256(data).hexdigest())
        snap = json.loads(data)
        self.assertEqual(snap["format"], "bidbridge-ledger-snapshot/1")
        self.assertEqual(len(snap["chain_anchors"]), 1)
        self.assertNotIn("payload", snap["database_anchors"][0])
        self.assertNotIn("Laptops", data.decode())          # no record contents


class BackupVerifyTests(APITestCase):
    """`backup_db --verify`: prove a backup restores before you need it."""

    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        make_project()

    def _backup(self):
        call_command("backup_db", "-o", self.folder, stdout=io.StringIO(), stderr=io.StringIO())
        [name] = [n for n in os.listdir(self.folder) if not n.endswith(".sha256")]
        return os.path.join(self.folder, name)

    def _verify(self, path):
        out = io.StringIO()
        call_command("backup_db", "--verify", path, stdout=out, stderr=io.StringIO())
        return out.getvalue()

    def test_an_encrypted_backup_verifies_without_writing_plaintext(self):
        with override_settings(FILE_ENCRYPTION_KEY=throwaway_key()):
            path = self._backup()
            self.assertTrue(path.endswith(".json.enc"))
            out = self._verify(path)
        self.assertIn("Checksum OK", out)
        self.assertIn("procurement.project: 1", out)
        self.assertEqual(sorted(os.listdir(self.folder)),
                         sorted([os.path.basename(path), os.path.basename(path) + ".sha256"]))

    def test_a_damaged_or_swapped_backup_is_refused(self):
        with override_settings(FILE_ENCRYPTION_KEY=throwaway_key()):
            path = self._backup()
            with open(path, "ab") as f:
                f.write(b"x")
            with self.assertRaisesMessage(CommandError, "Checksum MISMATCH"):
                self._verify(path)

    def test_the_wrong_key_is_reported_without_crashing(self):
        with override_settings(FILE_ENCRYPTION_KEY=throwaway_key()):
            path = self._backup()
        with override_settings(FILE_ENCRYPTION_KEY=throwaway_key()):
            with self.assertRaisesMessage(CommandError, "Could not decrypt"):
                self._verify(path)


class BaseDocumentRenewalTests(_TempMediaMixin, APITestCase):
    """A supplier renews an expired base document (Mayor's Permit, Tax
    Clearance) themselves. Before, the Upload button sent them to a Profile page
    with no upload, because base documents could only be replaced after the BAC
    office requested a revision."""

    def setUp(self):
        super().setUp()
        self.admin = make_admin()
        self.supplier = attach_base_documents(make_supplier(verified=True))
        self.supplier.mayors_permit_expiry = timezone.localdate() - timedelta(days=3)
        self.supplier.tax_clearance_expiry = timezone.localdate() + timedelta(days=200)
        self.supplier.document_reviews = {"mayors_permit": {"status": "approved", "note": ""}}
        self.supplier.save()
        self.client.force_authenticate(user=self.supplier.user)

    def _upload(self, **files):
        return self.client.post("/api/suppliers/me/category-documents/", files, format="multipart")

    def test_an_expired_permit_can_be_renewed_and_waits_for_review(self):
        old_file = self.supplier.mayors_permit.name
        res = self._upload(catdoc_mayors_permit=dummy_pdf("permit-2027.pdf"),
                           catdoc_mayors_permit_expiry=IN_A_YEAR)
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.mayors_permit_expiry.isoformat(), IN_A_YEAR)
        self.assertNotEqual(self.supplier.mayors_permit.name, old_file)
        review = self.supplier.document_reviews["mayors_permit"]
        self.assertEqual(review["status"], "renewed")                        # waits for the Admin
        self.assertEqual(review["previous_expiry"], (timezone.localdate() - timedelta(days=3)).isoformat())
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)
        doc = next(d for d in res.data["documents"] if d["key"] == "mayors_permit")
        self.assertFalse(doc["expired"])
        self.assertTrue(Notification.objects.filter(user=self.admin, message__contains="Mayor").exists())
        self.assertTrue(Notification.objects.filter(user=self.supplier.user,
                                                    message__startswith="We received your").exists())

    def test_the_renewal_needs_a_future_expiry_date(self):
        res = self._upload(catdoc_mayors_permit=dummy_pdf("p.pdf"))
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        res = self._upload(catdoc_mayors_permit=dummy_pdf("p.pdf"), catdoc_mayors_permit_expiry=LAST_MONTH)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_valid_document_cannot_be_swapped_unreviewed(self):
        res = self._upload(catdoc_tax_clearance_certificate=dummy_pdf("t.pdf"),
                           catdoc_tax_clearance_certificate_expiry=IN_TWO_YEARS)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        res = self._upload(catdoc_valid_id=dummy_pdf("id.pdf"))
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_document_expiring_within_30_days_can_be_renewed_early(self):
        self.supplier.tax_clearance_expiry = timezone.localdate() + timedelta(days=10)
        self.supplier.save(update_fields=["tax_clearance_expiry"])
        res = self._upload(catdoc_tax_clearance_certificate=dummy_pdf("t.pdf"),
                           catdoc_tax_clearance_certificate_expiry=IN_A_YEAR)
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)

    def test_a_flagged_document_goes_through_the_revision_panel(self):
        self.supplier.document_reviews = {"mayors_permit": {"status": "needs_revision", "note": "Blurry"}}
        self.supplier.save(update_fields=["document_reviews"])
        res = self._upload(catdoc_mayors_permit=dummy_pdf("p.pdf"), catdoc_mayors_permit_expiry=IN_A_YEAR)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("revision panel", str(res.data))


class DocumentAlertTests(_TempMediaMixin, APITestCase):
    """Suppliers are told about expired, expiring and missing documents: in the
    bell when they open the dashboard, and by email from the daily command."""

    def setUp(self):
        super().setUp()
        self.supplier = attach_base_documents(make_supplier(verified=True))
        self.client.force_authenticate(user=self.supplier.user)

    def _alerts(self):
        return list(Notification.objects.filter(user=self.supplier.user, link="/supplier/profile")
                    .values_list("message", flat=True))

    def test_nothing_is_sent_when_all_documents_are_in_order(self):
        self.supplier.mayors_permit_expiry = timezone.localdate() + timedelta(days=200)
        self.supplier.save(update_fields=["mayors_permit_expiry"])
        self.client.get("/api/suppliers/me/")
        self.assertEqual(self._alerts(), [])

    def test_opening_the_dashboard_raises_each_alert_once(self):
        self.supplier.mayors_permit_expiry = timezone.localdate() - timedelta(days=3)
        self.supplier.tax_clearance_expiry = timezone.localdate() + timedelta(days=10)
        self.supplier.bank_reference_letter = None
        self.supplier.save()
        for _ in range(3):
            res = self.client.get("/api/suppliers/me/")
            self.assertEqual(res.status_code, status.HTTP_200_OK)
        alerts = self._alerts()
        self.assertEqual(len(alerts), 3, alerts)
        self.assertTrue(any(a.startswith("Your Mayor") and "expired on" in a for a in alerts))
        self.assertTrue(any("Tax Clearance" in a and "expires on" in a for a in alerts))
        self.assertTrue(any("Bank Reference Letter is missing" in a for a in alerts))
        self.assertEqual(len(mail.outbox), 0)          # in-app only from the dashboard

    def test_a_renewal_with_a_new_date_can_warn_again(self):
        self.supplier.tax_clearance_expiry = timezone.localdate() + timedelta(days=10)
        self.supplier.save(update_fields=["tax_clearance_expiry"])
        self.client.get("/api/suppliers/me/")
        self.supplier.tax_clearance_expiry = timezone.localdate() + timedelta(days=20)
        self.supplier.save(update_fields=["tax_clearance_expiry"])
        self.client.get("/api/suppliers/me/")
        self.assertEqual(len(self._alerts()), 2)

    def test_the_daily_command_emails_once_and_dry_run_sends_nothing(self):
        self.supplier.mayors_permit_expiry = timezone.localdate() - timedelta(days=3)
        self.supplier.save(update_fields=["mayors_permit_expiry"])

        out = io.StringIO()
        call_command("notify_document_expiry", "--dry-run", stdout=out)
        self.assertIn("1 alert(s) would be sent", out.getvalue())
        self.assertEqual(self._alerts(), [])

        call_command("notify_document_expiry", stdout=io.StringIO())
        call_command("notify_document_expiry", stdout=io.StringIO())
        self.assertEqual(len(self._alerts()), 1)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.supplier.user.email])

    def test_rejected_suppliers_are_skipped(self):
        self.supplier.mayors_permit_expiry = timezone.localdate() - timedelta(days=3)
        self.supplier.qualification_status = Supplier.Qualification.REJECTED
        self.supplier.save()
        call_command("notify_document_expiry", stdout=io.StringIO())
        self.assertEqual(self._alerts(), [])


class RenewalReviewTests(_TempMediaMixin, APITestCase):
    """The Admin reviews a verified supplier's renewal. The supplier-level
    Approve button isn't shown for a verified supplier, so before this the
    Admin couldn't accept a renewed permit, or even tell which file was new."""

    def setUp(self):
        super().setUp()
        self.admin = make_admin()
        self.supplier = attach_base_documents(make_supplier(verified=True))
        self.supplier.mayors_permit_expiry = timezone.localdate() - timedelta(days=3)
        self.supplier.tax_clearance_expiry = timezone.localdate() - timedelta(days=3)
        self.supplier.save()
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post("/api/suppliers/me/category-documents/", {
            "catdoc_mayors_permit": dummy_pdf("p.pdf"), "catdoc_mayors_permit_expiry": IN_A_YEAR,
            "catdoc_tax_clearance_certificate": dummy_pdf("t.pdf"),
            "catdoc_tax_clearance_certificate_expiry": IN_A_YEAR,
        }, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.client.force_authenticate(user=self.admin)

    def _reviews(self):
        self.supplier.refresh_from_db()
        return self.supplier.document_reviews

    def test_the_admin_list_shows_renewals_to_review(self):
        row = next(r for r in self.client.get("/api/suppliers/").data if r["id"] == self.supplier.pk)
        self.assertEqual(row["documents_to_review"], 2)
        doc = next(d for d in self.client.get(f"/api/suppliers/{self.supplier.pk}/").data["documents"]
                   if d["key"] == "mayors_permit")
        self.assertEqual(doc["review_status"], "renewed")
        self.assertIsNotNone(doc["previous_expiry"])

    def test_accepting_a_renewal_keeps_the_supplier_verified_and_tells_them(self):
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/accept-documents/",
                               {"documents": ["mayors_permit"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        reviews = self._reviews()
        self.assertEqual(reviews["mayors_permit"]["status"], "approved")
        self.assertEqual(reviews["tax_clearance_certificate"]["status"], "renewed")   # untouched
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)
        self.assertTrue(Notification.objects.filter(
            user=self.supplier.user, message__startswith="The BAC office accepted your renewed").exists())
        self.assertTrue(AuditLog.objects.filter(action="supplier.documents_accepted").exists())

    def test_only_renewed_documents_can_be_accepted_here(self):
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/accept-documents/",
                               {"documents": ["valid_id"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_supplier_cannot_accept_their_own_renewal(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/accept-documents/",
                               {"documents": ["mayors_permit"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self._reviews()["mayors_permit"]["status"], "renewed")

    def test_flagging_one_renewal_never_approves_the_other_by_default(self):
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/request-revision/",
                               {"documents": {"mayors_permit": "Wrong business name"}}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        reviews = self._reviews()
        self.assertEqual(reviews["mayors_permit"]["status"], "needs_revision")
        self.assertEqual(reviews["tax_clearance_certificate"]["status"], "renewed")
        self.assertEqual(reviews["valid_id"]["status"], "approved")


class ProcurementCategoryTests(APITestCase):
    """The Admin can add a category beyond the built-in list; it then works for
    projects and for supplier eligibility like any built-in one."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()

    def test_list_is_public_and_starts_with_builtins(self):
        res = self.client.get("/api/categories/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["categories"], PROCUREMENT_CATEGORIES)

    def test_admin_adds_a_category(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post("/api/categories/", {"name": "  Security   Services "}, format="json")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(res.data["name"], "Security Services")
        self.assertIn("Security Services", self.client.get("/api/categories/").data["categories"])

    def test_adding_an_existing_name_returns_it_instead_of_a_duplicate(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post("/api/categories/", {"name": "it equipment"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["name"], "IT Equipment")
        self.assertFalse(res.data["created"])
        self.assertFalse(ProcurementCategory.objects.exists())

    def test_rejects_blank_and_comma_names(self):
        self.client.force_authenticate(user=self.admin)
        for name in ["", "   ", "Paint, Brushes"]:
            res = self.client.post("/api/categories/", {"name": name}, format="json")
            self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST, name)

    def test_only_admin_can_add(self):
        supplier = make_supplier()
        for user in (None, make_head(), supplier.user):
            self.client.force_authenticate(user=user)
            res = self.client.post("/api/categories/", {"name": "Security Services"}, format="json")
            self.assertIn(res.status_code, (401, 403))
        self.assertFalse(ProcurementCategory.objects.exists())

    def test_project_category_must_be_known(self):
        self.client.force_authenticate(user=self.admin)
        body = {"name": "Guards", "type": "Services", "category": "Security Services",
                "delivery_location": "HQ", "budget": "1000", "bidding_period_days": 10,
                "delivery_period_days": 30}
        res = self.client.post("/api/projects/", body, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", res.data)

    def test_added_category_drives_supplier_eligibility(self):
        ProcurementCategory.objects.create(name="Security Services")
        supplier = make_supplier(categories=["IT Equipment"])
        make_project(status=Project.Status.PUBLISHED, category="Security Services")

        self.client.force_authenticate(user=supplier.user)
        self.assertEqual(len(self.client.get("/api/projects/").json()), 0)
        res = self.client.patch("/api/suppliers/me/",
                                {"business_types": ["IT Equipment", "Security Services"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        supplier.refresh_from_db()
        # Built-ins keep their fixed order; added categories follow.
        self.assertEqual(supplier.pending_business_types, ["IT Equipment", "Security Services"])

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/suppliers/{supplier.pk}/approve-categories/")
        self.client.force_authenticate(user=supplier.user)
        self.assertEqual(len(self.client.get("/api/projects/").json()), 1)


# ── Separation of duties: Staff, BAC Committee, Head award approval ───────────
# (settings.BAC_WORKFLOW_ENABLED, procurement/bac.py, docs/BAC_ROLES_PLAN.md)

from .models import BACMembership, BACResolution, BACVote, BACVoteImmutable  # noqa: E402


def make_user(username, role, full_name=""):
    return User.objects.create_user(username=username, email=f"{username}@example.com",
                                    password="pw", role=role, full_name=full_name or username.title())


@override_settings(BAC_WORKFLOW_ENABLED=True)
class BACWorkflowTests(APITestCase):
    PASS = {"eligibility_ok": True, "technical_ok": True, "financial_ok": True, "remarks": "Complete."}
    FAIL = {"eligibility_ok": True, "technical_ok": False, "financial_ok": True,
            "remarks": "Specs not met."}

    def setUp(self):
        cache.clear()
        self._media = tempfile.mkdtemp()
        self._override = override_settings(MEDIA_ROOT=self._media)
        self._override.enable()
        self.admin = make_admin()
        self.head = make_head()
        self.staff = make_user("staff", User.Role.STAFF)
        self.members = []
        for n, position in enumerate(["chair", "vice_chair", "member", "member", "member"], start=1):
            user = make_user(f"bac{n}", User.Role.BAC, f"Member {n}")
            self.members.append(BACMembership.objects.create(
                user=user, position=position, designated_on=timezone.localdate(),
                designation_reference="OO-2026-001", recorded_by=self.admin))
        self.project = make_project(status=Project.Status.CLOSED)
        Project.objects.filter(pk=self.project.pk).update(deadline=timezone.localdate() - timedelta(days=1))
        self.project.refresh_from_db()
        self.low = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=800)
        self.mid = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=900)
        self.high = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=1000)

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self._media, ignore_errors=True)

    # helpers
    def as_user(self, user):
        self.client.force_authenticate(user=user)
        return self.client

    def evaluate(self, bid, members, verdict):
        for m in members:
            res = self.as_user(m.user).post(f"/api/bac/bids/{bid.id}/evaluate/", verdict, format="json")
            self.assertIn(res.status_code, (200, 201), res.data)

    def everyone_passes_everything(self):
        for bid in (self.low, self.mid, self.high):
            self.evaluate(bid, self.members, self.PASS)

    def draft_resolution(self, justification="the lowest bid is responsive and passed post-qualification;"):
        return self.as_user(self.staff).post("/api/bac/resolutions/", {
            "project": self.project.id, "meeting_date": str(timezone.localdate()),
            "meeting_mode": "in_person", "venue": "BAC Room", "justification": justification,
        }, format="json")

    def adopted_resolution(self):
        self.everyone_passes_everything()
        res = self.as_user(self.members[0].user).post(
            f"/api/bac/bids/{self.low.id}/post-qualify/",
            {"result": "passed", "remarks": "Site visit and documents verified."}, format="json")
        self.assertEqual(res.status_code, 201, res.data)
        res = self.draft_resolution()
        self.assertEqual(res.status_code, 201, res.data)
        rid = res.data["id"]
        self.assertEqual(self.as_user(self.staff).post(f"/api/bac/resolutions/{rid}/open-voting/").status_code, 200)
        for m in self.members[:3]:
            res = self.as_user(m.user).post(f"/api/bac/resolutions/{rid}/vote/", {
                "choice": "approve", "comment": f"{m.user.full_name}: lowest responsive bid."}, format="json")
            self.assertEqual(res.status_code, 201, res.data)
        return BACResolution.objects.get(pk=rid)

    # the switch
    @override_settings(BAC_WORKFLOW_ENABLED=False)
    def test_with_the_switch_off_bac_actions_refuse_and_admin_keeps_working(self):
        res = self.as_user(self.members[0].user).post(
            f"/api/bac/bids/{self.low.id}/evaluate/", self.PASS, format="json")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(self.as_user(self.admin).post(f"/api/bids/{self.low.id}/qualify/").status_code, 200)

    def test_with_the_switch_on_admin_can_no_longer_prepare_evaluate_or_award(self):
        client = self.as_user(self.admin)
        self.assertEqual(client.post("/api/projects/", {}, format="json").status_code, 403)
        self.assertEqual(client.post(f"/api/projects/{self.project.id}/publish/").status_code, 403)
        self.assertEqual(client.post(f"/api/bids/{self.low.id}/qualify/").status_code, 403)
        self.assertEqual(client.post(f"/api/bids/{self.low.id}/select-winner/").status_code, 403)
        # Staff may prepare: the request reaches validation instead of a 403.
        self.assertNotEqual(self.as_user(self.staff).post("/api/projects/", {}, format="json").status_code, 403)
        # Nobody can use the one-person award any more, Staff and Head included.
        Bid.objects.filter(pk=self.low.pk).update(status=Bid.Status.QUALIFIED)
        for user in (self.staff, self.head):
            self.assertEqual(self.as_user(user).post(f"/api/bids/{self.low.id}/select-winner/").status_code, 403)

    # evaluation
    def test_bid_status_follows_the_majority_of_members(self):
        self.evaluate(self.low, self.members[:2], self.PASS)
        self.low.refresh_from_db()
        self.assertEqual(self.low.status, Bid.Status.UNDER_REVIEW)
        self.evaluate(self.low, self.members[2:3], self.PASS)
        self.low.refresh_from_db()
        self.assertEqual(self.low.status, Bid.Status.QUALIFIED)
        self.evaluate(self.high, self.members[:3], self.FAIL)
        self.high.refresh_from_db()
        self.assertEqual(self.high.status, Bid.Status.DISQUALIFIED)

    def test_failing_check_needs_remarks_and_bids_stay_sealed_until_the_deadline(self):
        client = self.as_user(self.members[0].user)
        res = client.post(f"/api/bac/bids/{self.low.id}/evaluate/", {**self.FAIL, "remarks": ""}, format="json")
        self.assertEqual(res.status_code, 400)
        Project.objects.filter(pk=self.project.pk).update(
            status=Project.Status.PUBLISHED, deadline=timezone.localdate() + timedelta(days=3))
        res = client.post(f"/api/bac/bids/{self.low.id}/evaluate/", self.PASS, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(client.get(f"/api/bac/projects/{self.project.id}/").status_code, 409)

    def test_only_seated_members_evaluate_and_members_see_others_only_after_their_own(self):
        outsider = make_user("bac9", User.Role.BAC)
        res = self.as_user(outsider).post(f"/api/bac/bids/{self.low.id}/evaluate/", self.PASS, format="json")
        self.assertEqual(res.status_code, 403)
        self.evaluate(self.low, self.members[:1], self.FAIL)
        detail = self.as_user(self.members[1].user).get(f"/api/bac/projects/{self.project.id}/").json()
        row = next(b for b in detail["bids"] if b["id"] == self.low.id)
        self.assertNotIn("remarks", row["evaluations"][0])
        detail = self.as_user(self.head).get(f"/api/bac/projects/{self.project.id}/").json()
        row = next(b for b in detail["bids"] if b["id"] == self.low.id)
        self.assertEqual(row["evaluations"][0]["remarks"], "Specs not met.")

    # ranking and post-qualification
    def test_ranking_is_lowest_first_and_only_the_chair_post_qualifies_the_candidate(self):
        self.everyone_passes_everything()
        ranking = self.as_user(self.staff).get(f"/api/bac/projects/{self.project.id}/").json()["ranking"]
        self.assertEqual([r["bid_id"] for r in ranking["rows"]], [self.low.id, self.mid.id, self.high.id])
        self.assertEqual(ranking["candidate_id"], self.low.id)
        body = {"result": "failed", "remarks": "Could not verify the bank reference."}
        self.assertEqual(self.as_user(self.members[1].user).post(
            f"/api/bac/bids/{self.low.id}/post-qualify/", body, format="json").status_code, 403)
        chair = self.as_user(self.members[0].user)
        self.assertEqual(chair.post(f"/api/bac/bids/{self.mid.id}/post-qualify/", body,
                                    format="json").status_code, 400)
        res = chair.post(f"/api/bac/bids/{self.low.id}/post-qualify/", body, format="json")
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["ranking"]["candidate_id"], self.mid.id)
        self.low.refresh_from_db()
        self.assertEqual(self.low.status, Bid.Status.DISQUALIFIED)
        # A member revising their evaluation can't bring a failed bid back.
        self.evaluate(self.low, self.members[:1], self.PASS)
        self.low.refresh_from_db()
        self.assertEqual(self.low.status, Bid.Status.DISQUALIFIED)

    # resolution, votes, Head
    def test_full_flow_adopts_freezes_and_the_head_awards_with_the_same_anchors(self):
        res = self.adopted_resolution()
        self.assertEqual(res.status, BACResolution.Status.ADOPTED)
        self.assertEqual(res.recommended_bid_id, self.low.id)
        with res.resolution_file.open("rb") as fh:
            frozen = fh.read()
        self.assertEqual(hashlib.sha256(frozen).hexdigest(), res.resolution_sha256)
        self.assertTrue(frozen.startswith(b"%PDF"))
        # The record links the frozen file; the Head may download it, a supplier may not.
        url = self.as_user(self.head).get(f"/api/bac/resolutions/{res.id}/").json()["resolution_file_url"]
        path = f"/api/files/bacresolution/{res.id}/resolution_file/"
        self.assertTrue(url.endswith(path), url)
        got = self.as_user(self.head).get(path)
        self.assertEqual(got.status_code, 200)
        self.assertEqual(hashlib.sha256(b"".join(got.streaming_content)).hexdigest(), res.resolution_sha256)
        self.assertEqual(self.as_user(self.low.supplier.user).get(path).status_code, 404)
        # Admin, Staff and BAC members can't approve the award; the Head can.
        for user in (self.admin, self.staff, self.members[0].user):
            self.assertEqual(self.as_user(user).post(f"/api/bac/resolutions/{res.id}/approve/").status_code, 403)
        out = self.as_user(self.head).post(f"/api/bac/resolutions/{res.id}/approve/", {}, format="json")
        self.assertEqual(out.status_code, 200, out.data)
        self.project.refresh_from_db()
        self.low.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.AWARDED)
        self.assertIsNotNone(self.project.awarded_at)
        self.assertEqual(self.low.status, Bid.Status.WINNER)
        stages = [a["stage"] for a in out.data["anchor_sequence"]]
        self.assertEqual(stages, ["EVALUATION_COMPLETED", "BID_SUBMITTED", "AWARDED"])
        # Approving twice is refused; the award is made once.
        self.assertEqual(self.as_user(self.head).post(f"/api/bac/resolutions/{res.id}/approve/").status_code, 400)
        self.assertEqual(Award.objects.filter(project=self.project).count(), 1)
        # Staff issue the BAC Resolution: it is the frozen file, byte for byte.
        award = Award.objects.get(project=self.project)
        out = self.as_user(self.staff).post(f"/api/awards/{award.id}/documents/generate/",
                                            {"key": "award_resolution"}, format="json")
        self.assertEqual(out.status_code, 200, out.data)
        award.refresh_from_db()
        with award.award_resolution.open("rb") as fh:
            self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), res.resolution_sha256)
        self.assertEqual(out.data["anchor"]["stage"], "RESOLUTION_ISSUED")

    def test_votes_need_a_comment_and_can_never_be_changed(self):
        self.everyone_passes_everything()
        self.as_user(self.members[0].user).post(f"/api/bac/bids/{self.low.id}/post-qualify/",
                                               {"result": "passed", "remarks": "Verified."}, format="json")
        rid = self.draft_resolution().data["id"]
        self.as_user(self.staff).post(f"/api/bac/resolutions/{rid}/open-voting/")
        voter = self.as_user(self.members[3].user)
        self.assertEqual(voter.post(f"/api/bac/resolutions/{rid}/vote/",
                                    {"choice": "approve", "comment": "ok"}, format="json").status_code, 400)
        self.assertEqual(voter.post(f"/api/bac/resolutions/{rid}/vote/", {
            "choice": "disapprove", "comment": "Delivery schedule is too tight."}, format="json").status_code, 201)
        self.assertEqual(voter.post(f"/api/bac/resolutions/{rid}/vote/", {
            "choice": "approve", "comment": "Changed my mind about it."}, format="json").status_code, 400)
        vote = BACVote.objects.get(resolution_id=rid)
        self.assertEqual((vote.voter_name, vote.voter_position), ("Member 4", "member"))
        vote.comment = "edited"
        with self.assertRaises(BACVoteImmutable):
            vote.save()
        with self.assertRaises(BACVoteImmutable):
            vote.delete()

    def test_the_head_can_return_it_and_a_new_resolution_can_follow(self):
        res = self.adopted_resolution()
        client = self.as_user(self.head)
        self.assertEqual(client.post(f"/api/bac/resolutions/{res.id}/return/", {"remarks": "short"},
                                     format="json").status_code, 400)
        out = client.post(f"/api/bac/resolutions/{res.id}/return/",
                          {"remarks": "Please re-check the delivery schedule."}, format="json")
        self.assertEqual(out.status_code, 200)
        res.refresh_from_db()
        self.assertEqual((res.status, res.head_decision), ("returned", "returned"))
        self.project.refresh_from_db()
        self.assertNotEqual(self.project.status, Project.Status.AWARDED)
        again = self.draft_resolution("re-checked the delivery schedule with the bidder.")
        self.assertEqual(again.status_code, 201, again.data)
        self.assertTrue(again.data["number"].endswith("-2"))

    # designations and accounts
    def test_seat_rules_head_excluded_five_seats_one_chair(self):
        client = self.as_user(self.admin)
        body = {"user": self.head.id, "position": "member", "designated_on": "2026-01-05",
                "designation_reference": "OO-2"}
        self.assertEqual(client.post("/api/bac/memberships/", body, format="json").status_code, 400)
        extra = make_user("bac6", User.Role.BAC)
        res = client.post("/api/bac/memberships/", {**body, "user": extra.id}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("5 seats", res.data["detail"])
        self.members[4].active = False
        self.members[4].save()
        res = client.post("/api/bac/memberships/", {**body, "user": extra.id, "position": "chair"}, format="json")
        self.assertEqual(res.status_code, 400)
        res = client.post("/api/bac/memberships/", {**body, "user": extra.id}, format="json")
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(self.as_user(self.staff).post("/api/bac/memberships/", body,
                                                       format="json").status_code, 403)

    def test_records_survive_a_resignation(self):
        res = self.adopted_resolution()
        out = self.as_user(self.admin).post(f"/api/bac/memberships/{self.members[1].id}/end/",
                                            {"end_reason": "Resigned"}, format="json")
        self.assertEqual(out.status_code, 200)
        record = self.as_user(self.admin).get(f"/api/bac/resolutions/{res.id}/").json()
        vice = next(v for v in record["votes"] if v["voter_position"] == "vice_chair")
        self.assertFalse(vice["member_active"])
        self.assertIn("lowest responsive bid", vice["comment"])
        self.assertEqual(self.as_user(self.members[0].user).get("/api/bac/resolutions/").status_code, 200)
        supplier = self.low.supplier.user
        self.assertEqual(self.as_user(supplier).get("/api/bac/resolutions/").status_code, 403)
        self.assertEqual(self.as_user(supplier).get(f"/api/bac/projects/{self.project.id}/").status_code, 403)

    def test_bac_members_see_no_bids_before_the_deadline(self):
        member = self.as_user(self.members[2].user)
        self.assertEqual(len(member.get(f"/api/bids/?project={self.project.id}").json()), 3)
        Project.objects.filter(pk=self.project.pk).update(
            status=Project.Status.PUBLISHED, deadline=timezone.localdate() + timedelta(days=2))
        self.assertEqual(member.get(f"/api/bids/?project={self.project.id}").json(), [])
        self.assertEqual(member.get(f"/api/bids/{self.low.id}/").status_code, 404)

    def test_evaluated_bids_cannot_be_deleted(self):
        self.evaluate(self.low, self.members[:1], self.PASS)
        res = self.as_user(self.admin).delete(f"/api/bids/{self.low.id}/")
        self.assertEqual(res.status_code, 400)
        self.assertTrue(Bid.objects.filter(pk=self.low.pk).exists())

    def test_admin_manages_staff_bac_and_head_accounts_only(self):
        client = self.as_user(self.admin)
        body = {"username": "newstaff", "email": "newstaff@example.com", "full_name": "New Staff",
                "role": "staff", "password": "Correct-Horse-Battery-9"}
        res = client.post("/api/auth/users/", body, format="json")
        self.assertEqual(res.status_code, 201, res.data)
        self.assertNotIn("password", res.data)
        self.assertTrue(User.objects.get(username="newstaff").check_password("Correct-Horse-Battery-9"))
        res = client.post("/api/auth/users/", {**body, "username": "boss", "email": "b@example.com",
                                               "role": "admin"}, format="json")
        self.assertEqual(res.status_code, 400)
        res = client.patch(f"/api/auth/users/{self.members[0].user.id}/", {"is_active": False}, format="json")
        self.assertEqual(res.status_code, 400)
        res = client.patch(f"/api/auth/users/{self.staff.id}/", {"is_active": False, "role": "admin"},
                           format="json")
        self.assertEqual(res.status_code, 200)
        self.staff.refresh_from_db()
        self.assertEqual((self.staff.is_active, self.staff.role), (False, "staff"))
        self.assertEqual(self.as_user(self.head).get("/api/auth/users/").status_code, 403)
