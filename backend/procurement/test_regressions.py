"""Regression tests for the bugs found in the 2026-08 codebase audit.

Each class below pins ONE defect that was confirmed by execution before it was
fixed. The docstrings record what actually went wrong, so a future change that
reintroduces the behaviour fails here with an explanation rather than just a red
assertion.
"""
import contextlib
import io
import json
import re
import tempfile
from datetime import datetime
from datetime import timezone as dt_timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest import mock, skipUnless

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework import status
from rest_framework.test import APITestCase, APITransactionTestCase

from accounts.emails import email_verification_token
from accounts.models import AuditLog
from accounts.serializers import RoleTokenObtainPairSerializer
from accounts.tests import registration_payload

from . import blockchain
from .management.commands import seed as seed_cmd
from .models import Award, Bid, BidAttachment, BlockchainAnchor, Project, Supplier, SupplierCategoryDocument
from .blockchain import hash_payload, verify_anchor
from .tests import IN_A_YEAR, IN_TWO_YEARS, attach_base_documents, dummy_pdf, make_admin, make_head, make_project, make_supplier

User = get_user_model()


def qualified_bid(project, supplier, amount=1000):
    return Bid.objects.create(
        project=project, supplier=supplier, amount=amount, status=Bid.Status.QUALIFIED,
    )


class LedgerAbiLocationTests(TestCase):
    """Heroku deploys backend/ alone, so the ABI must not be read from the repo's
    contracts/ folder, which doesn't exist there. Reading it from that path made
    every server write and receipt check fail."""

    def test_abi_is_found_without_the_repo_around_the_backend(self):
        # Where production's BASE_DIR is: nothing beside it, so nothing above it
        # may be needed.
        with tempfile.TemporaryDirectory() as empty, override_settings(BASE_DIR=Path(empty) / "app"):
            abi = blockchain._ledger_abi()
        self.assertIn("recordEvent", {entry.get("name") for entry in abi})

    def test_abi_file_ships_inside_the_backend(self):
        module_dir = Path(blockchain.__file__).resolve().parent
        self.assertTrue((module_dir / "ProcurementLedger.abi.json").is_file())
        self.assertTrue(module_dir.is_relative_to(Path(settings.BASE_DIR).resolve()))

    def test_backend_abi_matches_the_contract_source(self):
        # Parsed, not byte-compared: git may check text out with other line endings.
        source = Path(settings.BASE_DIR).parent / "contracts" / "ProcurementLedger.abi.json"
        if not source.is_file():
            self.skipTest("contracts/ isn't here: running from a backend-only deploy.")
        self.assertEqual(blockchain._ledger_abi(), json.loads(source.read_text(encoding="utf-8")))


class ProjectCodeGenerationTests(APITestCase):
    """Codes were derived from `.count() + 1`, so deleting a project made the
    next create re-propose a code that still existed — an IntegrityError on the
    unique column that permanently blocked new procurements for that year."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.client.force_authenticate(user=self.admin)

    def _create(self):
        return self.client.post("/api/projects/", {
            "name": "Test procurement", "type": "Goods", "category": "IT Equipment",
            "delivery_location": "HQ", "budget": "1000",
            "bidding_period_days": 10, "delivery_period_days": 30,
            "purchase_request": dummy_pdf(), "technical_specifications": dummy_pdf(),
            "terms_of_reference": dummy_pdf(), "approved_budget_document": dummy_pdf(),
            "bid_evaluation_criteria": dummy_pdf(),
        }, format="multipart")

    def test_codes_do_not_collide_after_a_project_is_deleted(self):
        first = self._create()
        second = self._create()
        third = self._create()
        for res in (first, second, third):
            self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)

        # Remove the middle one — a count-based scheme now proposes the third
        # project's existing code.
        Project.objects.filter(pk=second.data["id"]).delete()

        fourth = self._create()
        self.assertEqual(fourth.status_code, status.HTTP_201_CREATED, fourth.data)
        codes = set(Project.objects.values_list("code", flat=True))
        self.assertEqual(len(codes), 3)
        self.assertIn(fourth.data["code"], codes)

    def test_codes_are_random_and_not_sequential(self):
        """Sequential codes ("P-2026-001", "-002", ...) let anyone guess every
        other procurement's reference from one. New codes are long and random."""
        codes = [self._create().data["code"] for _ in range(5)]
        pattern = re.compile(r"^PC-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}$")
        for code in codes:
            self.assertRegex(code, pattern)
            self.assertLessEqual(len(code), Project._meta.get_field("code").max_length)
        self.assertEqual(len(set(codes)), 5)

    def test_create_retries_when_a_random_code_is_already_taken(self):
        existing = self._create().data["code"]
        with mock.patch(
            "procurement.views.next_project_code",
            side_effect=[existing, existing, "PC-ABCD-EFGH-JKMN"],
        ):
            res = self._create()
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(res.data["code"], "PC-ABCD-EFGH-JKMN")


class PublishRequiresHeadApprovalTests(APITestCase):
    """`publish` had no status check, so an Admin could POST straight to it and
    open a draft — or a Head-REJECTED procurement — for bidding, bypassing the
    approval gate the whole workflow exists to enforce."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()

    def _publish(self, project):
        self.client.force_authenticate(user=self.admin)
        return self.client.post(f"/api/projects/{project.pk}/publish/")

    def test_cannot_publish_a_rejected_procurement(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{project.pk}/reject/", {"reason": "no"}, format="json")

        res = self._publish(project)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        project.refresh_from_db()
        self.assertEqual(project.status, Project.Status.REJECTED)

    def test_cannot_publish_a_procurement_still_awaiting_the_head(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        res = self._publish(project)
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        project.refresh_from_db()
        self.assertEqual(project.status, Project.Status.PENDING_HEAD)

    def test_can_publish_once_the_head_has_approved(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        project.bidding_period_days = 14
        project.save()
        self.client.force_authenticate(user=self.head)
        self.client.post(f"/api/projects/{project.pk}/approve/")

        res = self._publish(project)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        self.assertEqual(project.status, Project.Status.PUBLISHED)
        self.assertIsNotNone(project.deadline)


class SelectWinnerGuardTests(APITestCase):
    """select_winner checked only for flagged documents. Two calls for two
    different suppliers both returned 200, because Award.get_or_create keys on
    (project, supplier) — producing TWO `won` awards for one contract, both
    published and both anchored on-chain as the winner."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.first = make_supplier()
        self.second = make_supplier()
        self.bid_a = qualified_bid(self.project, self.first, 1000)
        self.bid_b = qualified_bid(self.project, self.second, 1100)
        self.client.force_authenticate(user=self.admin)

    def test_a_procurement_can_only_be_awarded_once(self):
        first = self.client.post(f"/api/bids/{self.bid_a.pk}/select-winner/")
        self.assertEqual(first.status_code, status.HTTP_200_OK)

        second = self.client.post(f"/api/bids/{self.bid_b.pk}/select-winner/")
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)

        self.assertEqual(Award.objects.filter(project=self.project).count(), 1)
        self.assertEqual(
            Bid.objects.filter(project=self.project, status=Bid.Status.WINNER).count(), 1)
        self.bid_b.refresh_from_db()
        self.assertEqual(self.bid_b.status, Bid.Status.QUALIFIED)

    def test_an_unqualified_bid_cannot_be_awarded(self):
        pending = Bid.objects.create(
            project=self.project, supplier=make_supplier(), amount=900,
            status=Bid.Status.UNDER_REVIEW,
        )
        res = self.client.post(f"/api/bids/{pending.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Award.objects.exists())

    def test_a_disqualified_bid_cannot_be_awarded(self):
        self.client.post(f"/api/bids/{self.bid_a.pk}/disqualify/")
        res = self.client.post(f"/api/bids/{self.bid_a.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Award.objects.exists())


class BidWithdrawalGuardTests(APITestCase):
    """A supplier could DELETE their own bid at any time — including after it
    had won. That orphaned the on-chain BID_SUBMITTED anchor, so the public
    verifier reported a real contract as 'unavailable'."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.supplier = make_supplier()
        self.bid = qualified_bid(self.project, self.supplier)

    def test_supplier_can_withdraw_while_bidding_is_open(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.delete(f"/api/bids/{self.bid.pk}/")
        self.assertEqual(res.status_code, status.HTTP_204_NO_CONTENT)

    def test_supplier_cannot_withdraw_a_winning_bid(self):
        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{self.bid.pk}/select-winner/")

        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.delete(f"/api/bids/{self.bid.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Bid.objects.filter(pk=self.bid.pk).exists())

    def test_supplier_cannot_withdraw_once_bidding_has_closed(self):
        self.project.status = Project.Status.CLOSED
        self.project.save(update_fields=["status"])
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.delete(f"/api/bids/{self.bid.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_can_still_delete_for_cleanup(self):
        self.project.status = Project.Status.CLOSED
        self.project.save(update_fields=["status"])
        self.client.force_authenticate(user=self.admin)
        res = self.client.delete(f"/api/bids/{self.bid.pk}/")
        self.assertEqual(res.status_code, status.HTTP_204_NO_CONTENT)


class LoginEnumerationTests(APITestCase):
    """Login returned 'No account found with that username or email' for an
    unknown account and 'Incorrect password' for a known one, letting anyone
    test whether an email address was registered. It also appended 'your
    password was changed N ago' to an unauthenticated failure."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="realuser", email="real@example.com", password="Str0ng!Passphrase1",
            role=User.Role.ADMIN,
        )

    def _login(self, username, password):
        return self.client.post(
            "/api/auth/login/", {"username": username, "password": password}, format="json")

    def test_unknown_account_and_wrong_password_are_indistinguishable(self):
        unknown = self._login("ghost@example.com", "whatever123")
        wrong = self._login("realuser", "wrongpassword123")

        self.assertEqual(unknown.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(wrong.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(str(unknown.data["detail"][0]), str(wrong.data["detail"][0]))

    def test_failure_never_reveals_when_the_password_last_changed(self):
        from django.utils import timezone
        self.user.password_changed_at = timezone.now()
        self.user.save(update_fields=["password_changed_at"])

        res = self._login("realuser", "wrongpassword123")
        self.assertNotIn("changed", str(res.data["detail"][0]).lower())
        self.assertEqual(
            str(res.data["detail"][0]), RoleTokenObtainPairSerializer.INVALID_CREDENTIALS)

    def test_an_inactive_account_is_not_distinguishable_either(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        inactive = self._login("realuser", "Str0ng!Passphrase1")
        unknown = self._login("ghost@example.com", "Str0ng!Passphrase1")
        self.assertEqual(str(inactive.data["detail"][0]), str(unknown.data["detail"][0]))

    def test_correct_credentials_still_sign_in(self):
        res = self._login("realuser", "Str0ng!Passphrase1")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIn("access", res.data)
        self.assertEqual(res.data["user"]["role"], "admin")


class ProtectedFileAccessTests(APITestCase):
    """Uploads were linked at MEDIA_URL, whose route only exists when DEBUG is
    True — every document 404'd in production — and had no access control at
    all, so any URL holder could read a supplier's government ID or a rival's
    quotation. They are now served by procurement.files.ProtectedFileView."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.owner = make_supplier()
        self.rival = make_supplier()
        self.owner.valid_id = dummy_pdf("id.pdf")
        self.owner.save()

    def _url_for_owner(self):
        """The signed URL the API hands the supplier for their own document."""
        self.client.force_authenticate(user=self.owner.user)
        res = self.client.get("/api/suppliers/me/")
        doc = next(d for d in res.data["documents"] if d["key"] == "valid_id")
        return doc["url"]

    def test_serializer_emits_a_protected_url_not_a_media_path(self):
        url = self._url_for_owner()
        self.assertIn("/api/files/supplier/", url)
        self.assertNotIn("/media/", url)

    def test_owner_can_open_their_own_document(self):
        url = self._url_for_owner()
        res = self.client.get(url)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(b"".join(res.streaming_content), b"%PDF-1.4 fake")

    def _one_time_link_for_owner(self):
        """What a click does: ask for a one-time link with the JWT."""
        self.client.force_authenticate(user=self.owner.user)
        res = self.client.post(f"/api/files/supplier/{self.owner.pk}/valid_id/link/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        return res.data["url"]

    def test_serialized_url_is_not_a_credential(self):
        # The address in API responses carries no token, so it can be logged or
        # leaked without granting anything.
        url = self._url_for_owner()
        self.assertNotIn("t=", url)
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(url).status_code, status.HTTP_404_NOT_FOUND)

    def test_one_time_link_works_without_an_auth_header(self):
        # This is the case a browser download hits: a navigation carries no
        # Authorization header.
        url = self._one_time_link_for_owner()
        self.client.force_authenticate(user=None)
        res = self.client.get(url)
        self.assertEqual(res.status_code, status.HTTP_200_OK)

    def test_a_rival_supplier_cannot_read_the_document(self):
        self.client.force_authenticate(user=self.rival.user)
        res = self.client.get(f"/api/files/supplier/{self.owner.pk}/valid_id/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_anonymous_without_a_token_is_refused(self):
        self.client.force_authenticate(user=None)
        res = self.client.get(f"/api/files/supplier/{self.owner.pk}/valid_id/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_token_cannot_be_replayed_against_another_record(self):
        # The rival must ALSO have a file on this field, otherwise the request
        # would 404 merely because there is nothing there and the test would
        # pass without ever exercising the signature check.
        self.rival.valid_id = dummy_pdf("rival-id.pdf")
        self.rival.save()

        url = self._one_time_link_for_owner()
        token = url.split("t=")[1]
        self.client.force_authenticate(user=None)
        # Same signature, different supplier in the path — the token is bound to
        # one kind/pk/field, so it must not unlock the rival's document.
        res = self.client.get(f"/api/files/supplier/{self.rival.pk}/valid_id/?t={token}")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_tampered_token_is_rejected(self):
        url = self._one_time_link_for_owner()
        base, token = url.split("?t=")
        self.client.force_authenticate(user=None)
        # Flip the last character of the signature.
        broken = token[:-1] + ("a" if token[-1] != "a" else "b")
        self.assertEqual(
            self.client.get(f"{base}?t={broken}").status_code, status.HTTP_404_NOT_FOUND)

    def test_admin_can_read_any_supplier_document(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.get(f"/api/files/supplier/{self.owner.pk}/valid_id/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

    def test_an_unlisted_field_cannot_be_addressed(self):
        # The field name is caller-supplied, so it must be a strict allow-list;
        # otherwise getattr() would reach any attribute on the model.
        self.client.force_authenticate(user=self.admin)
        res = self.client.get(f"/api/files/supplier/{self.owner.pk}/admin_notes/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_rival_cannot_read_another_suppliers_bid_quotation(self):
        project = make_project(status=Project.Status.PUBLISHED)
        bid = Bid.objects.create(
            project=project, supplier=self.owner, amount=100,
            quotation_document=dummy_pdf("quote.pdf"),
        )
        self.client.force_authenticate(user=self.rival.user)
        res = self.client.get(f"/api/files/bid/{bid.pk}/quotation_document/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)


class BidAttachmentReplacementTests(APITestCase):
    """Re-submitting a bid appended attachments instead of replacing them, so
    editing a bid three times left three copies of every file."""

    def setUp(self):
        cache.clear()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.supplier = make_supplier()
        self.client.force_authenticate(user=self.supplier.user)

    def _submit(self, attachments=1):
        payload = {
            "amount": "500", "delivery_timeline": "30 days", "notes": "a" * 30,
            "terms_accepted": "true", "interest_declared": "true",
            "scm_declared": "true", "accuracy_confirmed": "true",
            "quotation_document": dummy_pdf("q.pdf"),
        }
        if attachments:
            payload["other_attachments"] = [dummy_pdf(f"x{i}.pdf") for i in range(attachments)]
        return self.client.post(f"/api/projects/{self.project.pk}/bid/", payload, format="multipart")

    def test_resubmitting_replaces_attachments_instead_of_appending(self):
        for _ in range(3):
            self.assertIn(self._submit(1).status_code, (200, 201))
        bid = Bid.objects.get(project=self.project, supplier=self.supplier)
        self.assertEqual(bid.attachments.count(), 1)

    def test_resubmitting_without_attachments_keeps_the_existing_ones(self):
        self._submit(2)
        bid = Bid.objects.get(project=self.project, supplier=self.supplier)
        self.assertEqual(bid.attachments.count(), 2)

        self._submit(0)   # no new files attached
        self.assertEqual(bid.attachments.count(), 2)


class AnchorAttachValidationTests(APITestCase):
    """A non-numeric anchor_id reached filter(id=...) and raised ValueError,
    which DRF surfaced as a 500 instead of a 400."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project()
        self.client.force_authenticate(user=self.admin)

    def test_non_numeric_anchor_id_is_a_bad_request_not_a_server_error(self):
        res = self.client.post(
            f"/api/projects/{self.project.pk}/anchor/",
            {"anchor_id": "abc", "tx_hash": "0x" + "a" * 64}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


class ProjectImmutabilityTests(APITestCase):
    """A published procurement stayed fully editable and deletable. Editing it
    rewrote terms suppliers had already bid against and made verify_anchor
    report the record as altered on the public verification page."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.client.force_authenticate(user=self.admin)

    def test_cannot_edit_a_published_procurement(self):
        project = make_project(status=Project.Status.PUBLISHED)
        res = self.client.patch(
            f"/api/projects/{project.pk}/", {"budget": "1"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        project.refresh_from_db()
        self.assertEqual(int(project.budget), 50000)

    def test_cannot_delete_an_awarded_procurement(self):
        project = make_project(status=Project.Status.AWARDED)
        res = self.client.delete(f"/api/projects/{project.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Project.objects.filter(pk=project.pk).exists())

    def test_a_procurement_under_revision_can_still_be_edited_and_deleted(self):
        # Was: edited while PENDING_HEAD. Editing mid-review is now refused (see
        # ProjectEditWorkflowTests) — the Head must see the version they approve.
        project = make_project(status=Project.Status.NEEDS_REVISION)
        edit = self.client.patch(
            f"/api/projects/{project.pk}/", {"description": "clarified"}, format="json")
        self.assertEqual(edit.status_code, status.HTTP_200_OK)
        delete = self.client.delete(f"/api/projects/{project.pk}/")
        self.assertEqual(delete.status_code, status.HTTP_204_NO_CONTENT)

    def test_a_procurement_awaiting_the_head_can_still_be_deleted(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        delete = self.client.delete(f"/api/projects/{project.pk}/")
        self.assertEqual(delete.status_code, status.HTTP_204_NO_CONTENT)


class SupplierDeletionGuardTests(APITestCase):
    """Bid.supplier and Award.supplier CASCADE, so deleting a supplier who had
    bid silently took the evidence behind on-chain anchors with them."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.client.force_authenticate(user=self.admin)

    def test_cannot_delete_a_supplier_with_bids(self):
        supplier = make_supplier()
        Bid.objects.create(project=make_project(), supplier=supplier, amount=100)
        res = self.client.delete(f"/api/suppliers/{supplier.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Supplier.objects.filter(pk=supplier.pk).exists())

    def test_can_delete_a_supplier_who_never_bid(self):
        supplier = make_supplier()
        res = self.client.delete(f"/api/suppliers/{supplier.pk}/")
        self.assertEqual(res.status_code, status.HTTP_204_NO_CONTENT)


class RegistrationAtomicityTests(APITestCase):
    """User.save() and Supplier.objects.create() were not in a transaction, so
    a failure creating the profile left an orphan User — and validate_email
    then permanently locked that applicant out of their own address."""

    def setUp(self):
        cache.clear()

    def _payload(self, email="new@example.com"):
        return {
            "full_name": "Test Person", "email": email,
            "password": "Str0ng!Passphrase1", "confirm_password": "Str0ng!Passphrase1",
            "company_name": "New Co", "company_address": "Manila",
            "phone_number": "09171234567", "tin": "123-456-789",
            "representative_name": "Test Person",
            "business_types": '["IT Equipment"]',
            "declaration_accepted": "true",
            "sec_dti_certificate": dummy_pdf(), "mayors_permit": dummy_pdf(),
            "philgeps_certificate": dummy_pdf(), "valid_id": dummy_pdf(),
            "tax_clearance_certificate": dummy_pdf(),
            "audited_financial_statements": dummy_pdf(),
            "bank_reference_letter": dummy_pdf(), "authorization_letter": dummy_pdf(),
        }

    def test_a_failed_profile_create_leaves_no_orphan_user(self):
        from unittest.mock import patch
        with patch.object(Supplier.objects, "create", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.client.post(
                    "/api/auth/register/supplier/", self._payload(), format="multipart")

        # The User must have been rolled back with the profile.
        self.assertFalse(User.objects.filter(email="new@example.com").exists())

    def test_a_successful_registration_creates_both_rows(self):
        res = self.client.post(
            "/api/auth/register/supplier/", self._payload(), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        user = User.objects.get(email="new@example.com")
        self.assertTrue(Supplier.objects.filter(user=user).exists())


class UploadContentValidationTests(APITestCase):
    """Uploads were checked by file extension only, so anything renamed to .pdf
    was stored and later served back under a PDF content type."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.client.force_authenticate(user=self.admin)

    def test_a_non_pdf_disguised_as_a_pdf_is_rejected(self):
        fake = SimpleUploadedFile(
            "evil.pdf", b"<html><script>alert(1)</script></html>",
            content_type="application/pdf")
        res = self.client.post("/api/projects/", {
            "name": "Test", "type": "Goods", "category": "IT Equipment",
            "delivery_location": "HQ", "budget": "1000",
            "bidding_period_days": 10, "delivery_period_days": 30,
            "purchase_request": fake, "technical_specifications": dummy_pdf(),
            "terms_of_reference": dummy_pdf(), "approved_budget_document": dummy_pdf(),
            "bid_evaluation_criteria": dummy_pdf(),
        }, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_real_pdf_is_accepted_and_stored_intact(self):
        res = self.client.post("/api/projects/", {
            "name": "Test", "type": "Goods", "category": "IT Equipment",
            "delivery_location": "HQ", "budget": "1000",
            "bidding_period_days": 10, "delivery_period_days": 30,
            "purchase_request": dummy_pdf(), "technical_specifications": dummy_pdf(),
            "terms_of_reference": dummy_pdf(), "approved_budget_document": dummy_pdf(),
            "bid_evaluation_criteria": dummy_pdf(),
        }, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        # The signature check reads the file, so it must not truncate the save.
        project = Project.objects.get(pk=res.data["id"])
        project.purchase_request.open("rb")
        self.assertEqual(project.purchase_request.read(), b"%PDF-1.4 fake")
        project.purchase_request.close()


class NotificationCapTests(APITestCase):
    """The bell polls this list every 30s per user and notifications are never
    deleted, so a long-lived account re-downloaded its whole history twice a
    minute."""

    def setUp(self):
        cache.clear()
        self.supplier = make_supplier()
        self.client.force_authenticate(user=self.supplier.user)

    def test_list_is_capped_but_mark_read_still_covers_everything(self):
        from .models import Notification
        Notification.objects.bulk_create([
            Notification(user=self.supplier.user, message=f"n{i}") for i in range(60)
        ])

        res = self.client.get("/api/notifications/")
        self.assertEqual(len(res.data), 50)

        self.client.post("/api/notifications/mark-read/")
        self.assertEqual(
            Notification.objects.filter(user=self.supplier.user, is_read=False).count(), 0)


class AwardDocumentAccessTests(APITestCase):
    """The winner reads their own Notice of Award; nobody else's."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.winner = make_supplier()
        self.loser = make_supplier()
        Bid.objects.create(project=self.project, supplier=self.loser, amount=2000)
        self.bid = qualified_bid(self.project, self.winner, 1000)
        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{self.bid.pk}/select-winner/")
        self.award = Award.objects.get(project=self.project)
        mail.outbox.clear()

    def test_winner_can_read_their_generated_notice_of_award(self):
        res = self.client.post(
            f"/api/awards/{self.award.pk}/documents/generate/",
            {"key": "notice_of_award"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)

        self.client.force_authenticate(user=self.winner.user)
        doc = next(d for d in self.client.get("/api/awards/").data[0]["documents"]
                   if d["key"] == "notice_of_award")
        self.assertEqual(self.client.get(doc["url"]).status_code, status.HTTP_200_OK)

    def test_a_losing_bidder_cannot_read_the_award_document(self):
        # The NOA of an awarded procurement is public by design; the BAC
        # Resolution and the NTP are not.
        for key in ("award_resolution", "notice_to_proceed"):
            self.client.force_authenticate(user=self.admin)
            self.client.post(
                f"/api/awards/{self.award.pk}/documents/generate/", {"key": key}, format="json")
            self.client.force_authenticate(user=self.loser.user)
            res = self.client.get(f"/api/files/award/{self.award.pk}/{key}/")
            self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND, key)


class SeedCommandSafetyTests(TestCase):
    """`manage.py seed` refused only when DEBUG=False. backend/.env points DB_HOST
    at the live Supabase database and leaves DEBUG unset (True), so running the
    documented setup command on a developer machine passed the guard and would
    have deleted every production procurement and reset the role accounts to
    demo passwords. The guard now inspects the actual database connection."""

    SQLITE = {"ENGINE": "django.db.backends.sqlite3", "NAME": "db.sqlite3", "HOST": ""}
    SUPABASE = {"ENGINE": "django.db.backends.postgresql", "NAME": "postgres",
                "HOST": "aws-0-ap-southeast-1.pooler.supabase.com"}

    def _seed(self, *args, db=None, environ=None):
        patches = [mock.patch.object(seed_cmd, "database_settings", return_value=db or self.SQLITE)]
        if environ is not None:
            patches.append(mock.patch.dict(seed_cmd.os.environ, environ, clear=True))
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            call_command("seed", *args, stdout=io.StringIO())

    def _assert_untouched(self, project):
        self.assertTrue(Project.objects.filter(pk=project.pk).exists())
        self.assertEqual(Project.objects.count(), 1)

    # ── unconditional refusals: no flag gets past these ──────────────────────
    @override_settings(DEBUG=True)
    def test_remote_postgres_is_refused_even_with_debug_and_the_wipe_flag(self):
        project = make_project()
        with self.assertRaisesMessage(CommandError, "remote server"):
            self._seed("--wipe-local-data", db=self.SUPABASE, environ={})
        self._assert_untouched(project)

    @override_settings(DEBUG=True)
    def test_local_non_sqlite_server_is_refused(self):
        db = {"ENGINE": "django.db.backends.postgresql", "HOST": "localhost"}
        with self.assertRaisesMessage(CommandError, "not SQLite"):
            self._seed("--wipe-local-data", db=db, environ={})

    @override_settings(DEBUG=True)
    def test_running_on_render_is_refused(self):
        with self.assertRaisesMessage(CommandError, "hosting platform"):
            self._seed("--wipe-local-data", environ={"RENDER": "true"})

    @override_settings(DEBUG=False)
    def test_debug_false_is_refused_even_with_the_wipe_flag(self):
        with self.assertRaisesMessage(CommandError, "DEBUG=False"):
            self._seed("--wipe-local-data", environ={})

    def test_the_old_force_flag_no_longer_exists(self):
        with self.assertRaises(CommandError):
            self._seed("--force", environ={})

    # ── local SQLite: deliberate opt-in before destroying data ───────────────
    @override_settings(DEBUG=True)
    def test_local_database_with_data_needs_the_explicit_flag(self):
        project = make_project()
        with self.assertRaisesMessage(CommandError, "--wipe-local-data"):
            self._seed(environ={})
        self._assert_untouched(project)

    @override_settings(DEBUG=True)
    def test_local_database_seeds_with_the_explicit_flag(self):
        make_project()
        self._seed("--wipe-local-data", environ={})
        self.assertEqual(Project.objects.count(), 4)
        self.assertTrue(User.objects.filter(username="admin").exists())

    @override_settings(DEBUG=True)
    def test_empty_local_database_seeds_without_a_flag(self):
        self._seed(environ={})
        self.assertEqual(Project.objects.count(), 4)


class HeadDecisionStateTests(APITestCase):
    """Approve / reject / request-revision had no status check. The Head could
    approve an AWARDED procurement — it became `approved`, the Admin could
    publish it again and award it a second time — and each such call wrote a
    contradictory HEAD_* anchor to the append-only ledger."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.client.force_authenticate(user=self.head)

    def _decide(self, project, action):
        body = {"documents": {"purchase_request": "blurry"}} if action == "request-revision" else {}
        return self.client.post(f"/api/projects/{project.pk}/{action}/", body, format="json")

    def test_no_head_decision_applies_outside_pending_head(self):
        for state in (Project.Status.AWARDED, Project.Status.PUBLISHED, Project.Status.CLOSED,
                      Project.Status.APPROVED, Project.Status.REJECTED,
                      Project.Status.NEEDS_REVISION, Project.Status.DRAFT):
            for action in ("approve", "reject", "request-revision"):
                with self.subTest(state=state, action=action):
                    project = make_project(status=state)
                    res = self._decide(project, action)
                    self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST, res.data)
                    project.refresh_from_db()
                    self.assertEqual(project.status, state)
                    self.assertFalse(BlockchainAnchor.objects.filter(entity_id=str(project.pk)).exists())

    def test_an_awarded_procurement_can_never_be_reopened_for_bidding(self):
        project = make_project(status=Project.Status.AWARDED)
        self._decide(project, "approve")
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/projects/{project.pk}/publish/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        project.refresh_from_db()
        self.assertEqual(project.status, Project.Status.AWARDED)

    def test_each_decision_still_works_on_a_pending_procurement(self):
        expected = {"approve": Project.Status.APPROVED, "reject": Project.Status.REJECTED,
                    "request-revision": Project.Status.NEEDS_REVISION}
        for action, outcome in expected.items():
            with self.subTest(action=action):
                project = make_project(status=Project.Status.PENDING_HEAD)
                res = self._decide(project, action)
                self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
                project.refresh_from_db()
                self.assertEqual(project.status, outcome)

    def test_a_procurement_cannot_be_published_twice(self):
        project = make_project(status=Project.Status.APPROVED)
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/projects/{project.pk}/publish/").status_code, 200)
        self.assertEqual(self.client.post(f"/api/projects/{project.pk}/publish/").status_code, 400)
        self.assertEqual(BlockchainAnchor.objects.filter(
            entity_id=str(project.pk), stage=BlockchainAnchor.Stage.BIDDING_OPEN).count(), 1)


class AwardPreconditionTests(APITestCase):
    """select-winner only checked "not already AWARDED", so a bid on a project
    in any other state (approved, rejected, ...) could be turned into an award."""

    def setUp(self):
        cache.clear()
        self.client.force_authenticate(user=make_admin())

    def test_cannot_award_a_procurement_that_never_went_to_bidding(self):
        for state in (Project.Status.APPROVED, Project.Status.PENDING_HEAD, Project.Status.REJECTED):
            with self.subTest(state=state):
                bid = qualified_bid(make_project(status=state), make_supplier())
                res = self.client.post(f"/api/bids/{bid.pk}/select-winner/")
                self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST, res.data)
                self.assertFalse(Award.objects.filter(project=bid.project).exists())

    def test_award_response_reports_the_new_project_status(self):
        bid = qualified_bid(make_project(status=Project.Status.CLOSED), make_supplier())
        res = self.client.post(f"/api/bids/{bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.assertEqual(res.data["project_status"], Project.Status.AWARDED)
        self.assertEqual(res.data["status"], Bid.Status.WINNER)


class ProjectEditWorkflowTests(APITestCase):
    """An Admin could PATCH a Head-APPROVED procurement (budget, periods,
    documents) and publish it on an approval given to a different version, and
    edits skipped validation entirely — a budget of -5 and a 0-day bidding
    period were stored."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.client.force_authenticate(user=self.admin)

    def _patch(self, project, data, fmt="json"):
        return self.client.patch(f"/api/projects/{project.pk}/", data, format=fmt)

    def test_editing_an_approved_procurement_sends_it_back_for_reapproval(self):
        project = make_project(status=Project.Status.APPROVED)
        res = self._patch(project, {"description": "Updated delivery notes"})
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        project.refresh_from_db()
        self.assertEqual(project.status, Project.Status.PENDING_HEAD)
        self.assertIsNone(project.reviewed_at)
        # ...so it can't be published until the Head approves it again.
        self.assertEqual(self.client.post(f"/api/projects/{project.pk}/publish/").status_code, 400)
        self.assertTrue(self.head.notifications.filter(message__contains="approved again").exists())
        self.assertTrue(AuditLog.objects.filter(action="project.edited_after_approval",
                                                entity_id=str(project.pk)).exists())

    def test_cannot_edit_while_the_head_is_reviewing_or_after_rejection(self):
        for state in (Project.Status.PENDING_HEAD, Project.Status.REJECTED):
            with self.subTest(state=state):
                project = make_project(status=state)
                res = self._patch(project, {"description": "sneaky change"})
                self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
                project.refresh_from_db()
                self.assertEqual(project.description, "")

    def test_anchored_fields_are_immutable_after_submission(self):
        for field, value in (("budget", "1"), ("name", "Renamed"), ("category", "Furniture"),
                             ("bidding_period_days", 30), ("delivery_period_days", 90), ("type", "Works")):
            with self.subTest(field=field):
                project = make_project(status=Project.Status.APPROVED)
                res = self._patch(project, {field: value})
                self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST, res.data)
                project.refresh_from_db()
                self.assertEqual(project.status, Project.Status.APPROVED)

    def test_resending_an_unchanged_anchored_value_is_not_a_change(self):
        project = make_project(status=Project.Status.NEEDS_REVISION)
        res = self._patch(project, {"budget": "50000.00", "description": "ok"})
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)

    def test_documents_cannot_be_swapped_by_a_generic_edit(self):
        project = make_project(status=Project.Status.APPROVED)
        res = self._patch(project, {"purchase_request": dummy_pdf()}, fmt="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_head_review_state_is_not_writable(self):
        project = make_project(status=Project.Status.NEEDS_REVISION)
        project.document_reviews = {"purchase_request": {"status": "needs_revision", "note": "x"}}
        project.save()
        self._patch(project, {"document_reviews": {}})
        project.refresh_from_db()
        self.assertIn("purchase_request", project.document_reviews)

    def test_invalid_values_are_rejected_on_edit_too(self):
        cases = [("budget", "-5"), ("budget", "0"), ("bidding_period_days", 0),
                 ("bidding_period_days", 181), ("delivery_period_days", 0),
                 ("delivery_period_days", 366), ("category", "Not a category"), ("name", "  ")]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                project = make_project(status=Project.Status.DRAFT)
                project.bidding_period_days, project.delivery_period_days = 10, 30
                project.save()
                res = self._patch(project, {field: value})
                self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST, res.data)
        self.assertFalse(Project.objects.filter(budget__lte=0).exists())

    def test_a_draft_may_still_correct_its_anchored_fields(self):
        project = make_project(status=Project.Status.DRAFT)
        res = self._patch(project, {"budget": "75000"})
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        project.refresh_from_db()
        self.assertEqual(int(project.budget), 75000)

    def test_create_rejects_a_negative_budget(self):
        res = self.client.post("/api/projects/", {
            "name": "X", "type": "Goods", "category": "IT Equipment", "delivery_location": "HQ",
            "budget": "-1", "bidding_period_days": 10, "delivery_period_days": 30,
            "purchase_request": dummy_pdf(), "technical_specifications": dummy_pdf(),
            "terms_of_reference": dummy_pdf(), "approved_budget_document": dummy_pdf(),
            "bid_evaluation_criteria": dummy_pdf(),
        }, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("budget", res.data)


class GenericWriteBypassTests(APITestCase):
    """Bids, awards and suppliers were ModelViewSets, so an Admin could PATCH a
    bid's amount and set it to "winner", PATCH an award's amount, or PATCH a
    supplier straight to "verified" — bypassing evaluation, the award
    procedure and supplier review, with no audit entry and no anchor."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.supplier = make_supplier(verified=False)
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.bid = Bid.objects.create(project=self.project, supplier=self.supplier, amount=1000)
        self.client.force_authenticate(user=self.admin)

    def test_bid_amount_and_status_cannot_be_rewritten(self):
        for method in ("patch", "put"):
            with self.subTest(method=method):
                res = getattr(self.client, method)(
                    f"/api/bids/{self.bid.pk}/", {"amount": "1.00", "status": "winner"}, format="json")
                self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.bid.refresh_from_db()
        self.assertEqual((int(self.bid.amount), self.bid.status), (1000, Bid.Status.UNDER_REVIEW))

    def test_bids_and_awards_cannot_be_created_directly(self):
        res = self.client.post("/api/bids/", {"project": self.project.pk, "supplier": self.supplier.pk,
                                              "amount": "1"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        res = self.client.post("/api/awards/", {"project": self.project.pk, "supplier": self.supplier.pk,
                                                "amount": "1"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertFalse(Award.objects.exists())

    def test_award_cannot_be_edited_or_deleted(self):
        award = Award.objects.create(project=self.project, supplier=self.supplier, amount=1000)
        self.assertEqual(self.client.patch(f"/api/awards/{award.pk}/", {"amount": "5"}, format="json")
                         .status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertEqual(self.client.delete(f"/api/awards/{award.pk}/").status_code,
                         status.HTTP_405_METHOD_NOT_ALLOWED)
        award.refresh_from_db()
        self.assertEqual(int(award.amount), 1000)

    def test_supplier_cannot_be_verified_by_a_generic_edit(self):
        res = self.client.patch(f"/api/suppliers/{self.supplier.pk}/",
                                {"qualification_status": "verified", "email_verified": True}, format="json")
        self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        res = self.client.post("/api/suppliers/", {"company": "Ghost Co", "contact": "x",
                                                   "qualification_status": "verified"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.PENDING)

    def test_the_winning_bid_cannot_be_deleted_even_by_an_admin(self):
        self.bid.status = Bid.Status.WINNER
        self.bid.save()
        res = self.client.delete(f"/api/bids/{self.bid.pk}/")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Bid.objects.filter(pk=self.bid.pk).exists())

    def test_deletions_are_audit_logged(self):
        self.project.status = Project.Status.CLOSED
        self.project.save()
        self.assertEqual(self.client.delete(f"/api/bids/{self.bid.pk}/").status_code, 204)
        self.assertTrue(AuditLog.objects.filter(action="bid.deleted", entity_id=str(self.bid.pk)).exists())
        lone = make_supplier()
        self.assertEqual(self.client.delete(f"/api/suppliers/{lone.pk}/").status_code, 204)
        self.assertTrue(AuditLog.objects.filter(action="supplier.deleted", entity_id=str(lone.pk)).exists())

    def test_supplier_self_service_still_works(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"phone_number": "09171234567"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.assertEqual(self.client.delete(f"/api/bids/{self.bid.pk}/").status_code, 204)


class EmailVerificationGateTests(APITestCase):
    """An Admin could approve a supplier whose email address had never been
    confirmed — the UI showed an "Unverified" badge but nothing stopped the
    approval, so a supplier could be cleared to bid on an address nobody had
    proven was theirs. Separately, the verification link stopped working as
    soon as the supplier signed in, because the token hashed `last_login`."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.supplier = make_supplier(verified=False)   # email_verified defaults to False

    def _approve(self):
        self.client.force_authenticate(user=self.admin)
        return self.client.post(f"/api/suppliers/{self.supplier.pk}/approve/")

    def test_unverified_email_cannot_be_approved(self):
        res = self._approve()
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("verified their email", res.data["detail"])
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.PENDING)
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(AuditLog.objects.filter(action="supplier.verified").exists())

    def test_verified_email_can_be_approved(self):
        attach_base_documents(self.supplier)   # approval also needs every required document
        self.supplier.email_verified = True
        self.supplier.save()
        self.assertEqual(self._approve().status_code, status.HTTP_200_OK)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)

    def test_email_verified_cannot_be_set_through_the_api(self):
        # Admin generic edit is gone (405) ...
        self.client.force_authenticate(user=self.admin)
        res = self.client.patch(f"/api/suppliers/{self.supplier.pk}/", {"email_verified": True}, format="json")
        self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        # ... and the supplier's own profile edit silently ignores the field.
        self.client.force_authenticate(user=self.supplier.user)
        self.client.patch("/api/suppliers/me/", {"email_verified": True}, format="json")
        self.supplier.refresh_from_db()
        self.assertFalse(self.supplier.email_verified)
        self.assertEqual(self._approve().status_code, status.HTTP_400_BAD_REQUEST)

    def test_supplier_cannot_approve_themselves(self):
        self.supplier.email_verified = True
        self.supplier.save()
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_link_still_works_after_the_supplier_logs_in(self):
        user = self.supplier.user
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = email_verification_token.make_token(user)
        login = self.client.post("/api/auth/login/", {"username": user.username, "password": "pw"},
                                 format="json")
        self.assertEqual(login.status_code, status.HTTP_200_OK)   # sets last_login
        res = self.client.post("/api/auth/verify-email/confirm/", {"uid": uid, "token": token},
                               format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertTrue(self.supplier.email_verified)

    def test_link_dies_when_the_email_changes(self):
        user = self.supplier.user
        token = email_verification_token.make_token(user)
        user.email = "someone.else@example.com"
        user.save()
        self.assertFalse(email_verification_token.check_token(user, token))

    def test_a_verification_link_is_not_a_password_reset_token(self):
        from django.contrib.auth.tokens import default_token_generator
        token = email_verification_token.make_token(self.supplier.user)
        self.assertFalse(default_token_generator.check_token(self.supplier.user, token))

    def test_full_flow_register_verify_then_approve(self):
        res = self.client.post("/api/auth/register/supplier/",
                               registration_payload(email="newco@example.com"), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        supplier = Supplier.objects.get(user__email="newco@example.com")
        self.assertFalse(supplier.email_verified)

        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/suppliers/{supplier.pk}/approve/").status_code,
                         status.HTTP_400_BAD_REQUEST)

        link = next(m.body for m in mail.outbox if "newco@example.com" in m.to)
        query = parse_qs(urlparse(re.search(r"https?://\S+", link).group(0)).query)
        self.client.force_authenticate(user=None)
        res = self.client.post("/api/auth/verify-email/confirm/",
                               {"uid": query["uid"][0], "token": query["token"][0]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)

        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/suppliers/{supplier.pk}/approve/").status_code,
                         status.HTTP_200_OK)


class LegacyRegisterRouteRemovedTests(APITestCase):
    """The unused public /api/auth/register/ created a bare `supplier` account
    with no profile and accepted an email that already belonged to someone. A
    stranger could take `username=<a supplier's email>` first and permanently
    block that supplier's real registration (supplier registration rejects an
    email that already exists as a username), and duplicate emails made
    login-by-email and password reset resolve to an arbitrary account. The
    route was removed; supplier self-registration is the only public sign-up."""

    def setUp(self):
        cache.clear()

    def test_the_legacy_route_is_gone(self):
        res = self.client.post("/api/auth/register/", {
            "username": "squatter", "email": "victim@example.com", "password": "Str0ng!Passphrase1",
        }, format="json")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(User.objects.exists())

    def test_supplier_self_registration_still_works_and_needs_email_verification(self):
        res = self.client.post("/api/auth/register/supplier/",
                               registration_payload(email="real.supplier@example.com"), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        user = User.objects.get(email="real.supplier@example.com")
        self.assertEqual(user.role, User.Role.SUPPLIER)
        supplier = Supplier.objects.get(user=user)
        self.assertFalse(supplier.email_verified)
        self.assertEqual(supplier.qualification_status, Supplier.Qualification.PENDING)
        self.assertTrue(any("real.supplier@example.com" in m.to for m in mail.outbox))

    def test_supplier_registration_enforces_the_password_policy(self):
        # Carried over from the removed RegisterPasswordStrengthTests: the policy
        # must hold on the one public sign-up route that remains.
        payload = registration_payload(email="weak.pw@example.com")
        payload["password"] = payload["confirm_password"] = "123456"
        res = self.client.post("/api/auth/register/supplier/", payload, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("password", res.data)
        self.assertFalse(User.objects.filter(email="weak.pw@example.com").exists())

    def test_supplier_registration_cannot_reuse_an_existing_email_or_username(self):
        make_admin()   # username "admin", email admin@example.com
        res = self.client.post("/api/auth/register/supplier/",
                               registration_payload(email="admin@example.com"), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(User.objects.filter(email__iexact="admin@example.com").count(), 1)

    def test_role_cannot_be_chosen_at_registration(self):
        payload = registration_payload(email="wants.admin@example.com")
        payload["role"] = "admin"
        res = self.client.post("/api/auth/register/supplier/", payload, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(User.objects.get(email="wants.admin@example.com").role, User.Role.SUPPLIER)

    def test_no_other_unauthenticated_route_creates_an_account(self):
        attempts = {
            "/api/auth/admin/register-supplier/": ("multipart", registration_payload(email="a@example.com")),
            "/api/suppliers/": ("json", {"company": "Ghost", "contact": "x"}),
            "/api/auth/me/": ("json", {"username": "ghost", "password": "Str0ng!Passphrase1"}),
            "/api/auth/login/": ("json", {"username": "ghost", "password": "Str0ng!Passphrase1"}),
            "/api/auth/refresh/": ("json", {"refresh": "x"}),
            "/api/auth/logout/": ("json", {"refresh": "x"}),
            "/api/auth/password/reset/": ("json", {"email": "ghost@example.com"}),
            "/api/auth/verify-email/confirm/": ("json", {"uid": "x", "token": "y"}),
        }
        for path, (fmt, body) in attempts.items():
            with self.subTest(path=path):
                self.client.post(path, body, format=fmt)
                self.assertFalse(User.objects.exists(), path)
                self.assertFalse(Supplier.objects.exists(), path)

    def test_the_only_public_create_view_is_supplier_registration(self):
        """Structural guard: walk every URL and list the views that both allow
        anonymous callers and create objects. Adding a new public sign-up path
        must be a deliberate change to this test."""
        from django.urls import URLPattern, URLResolver, get_resolver
        from rest_framework.mixins import CreateModelMixin
        from rest_framework.permissions import AllowAny

        from accounts.views import SupplierRegisterView

        def walk(patterns):
            for p in patterns:
                if isinstance(p, URLResolver):
                    yield from walk(p.url_patterns)
                elif isinstance(p, URLPattern):
                    yield p

        public_creators = set()
        for pattern in walk(get_resolver().url_patterns):
            cls = getattr(pattern.callback, "cls", None) or getattr(pattern.callback, "view_class", None)
            if cls is None or not issubclass(cls, CreateModelMixin):
                continue
            if any(perm is AllowAny for perm in getattr(cls, "permission_classes", [])):
                public_creators.add(cls)
        self.assertEqual(public_creators, {SupplierRegisterView})


class CategoryChangeWorkflowTests(APITestCase):
    """A verified supplier's PATCH /suppliers/me/ {business_types} took effect
    immediately, so a supplier verified for one category could see, download
    the documents of, and bid on procurements in any other. A verified
    supplier now files a REQUEST; only an Admin decision changes the approved
    set, and nothing pending or rejected grants eligibility."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.head = make_head()
        self.supplier = make_supplier(verified=True, categories=["IT Equipment"])
        self.furniture = make_project(status=Project.Status.PUBLISHED, category="Furniture")
        self.furniture.terms_of_reference = dummy_pdf()
        self.furniture.save()

    def _request(self, categories, user=None):
        self.client.force_authenticate(user=user or self.supplier.user)
        return self.client.patch("/api/suppliers/me/", {"business_types": categories}, format="json")

    def _decide(self, decision, user=None, **body):
        self.client.force_authenticate(user=user or self.admin)
        return self.client.post(f"/api/suppliers/{self.supplier.pk}/{decision}-categories/", body, format="json")

    def _can_see_furniture(self):
        self.client.force_authenticate(user=self.supplier.user)
        visible = [p["id"] for p in self.client.get("/api/projects/").json()]
        doc = self.client.get(f"/api/files/project/{self.furniture.pk}/terms_of_reference/")
        return self.furniture.pk in visible, doc.status_code

    def test_request_is_pending_logged_and_announced(self):
        res = self._request(["IT Equipment", "Furniture"])
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment"])
        self.assertEqual(self.supplier.pending_business_types, ["IT Equipment", "Furniture"])
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.PENDING)
        self.assertIsNotNone(self.supplier.category_requested_at)
        log = AuditLog.objects.get(action="supplier.category_change_requested")
        self.assertIn("add Furniture", log.description)
        self.assertTrue(self.admin.notifications.filter(message__contains="category change").exists())

    def test_pending_category_grants_no_eligibility(self):
        self._request(["IT Equipment", "Furniture"])
        self.assertEqual(self._can_see_furniture(), (False, status.HTTP_404_NOT_FOUND))
        bid = self.client.post(f"/api/projects/{self.furniture.pk}/bid/", {"amount": "100"}, format="multipart")
        self.assertEqual(bid.status_code, status.HTTP_404_NOT_FOUND)

    def test_pending_category_gets_no_publish_notification(self):
        self._request(["IT Equipment", "Furniture"])
        approved = make_project(status=Project.Status.APPROVED, category="Furniture")
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/projects/{approved.pk}/publish/").status_code, 200)
        self.assertFalse(self.supplier.user.notifications.filter(message__contains="open for bidding").exists())

    def test_approval_activates_the_requested_set(self):
        self._request(["IT Equipment", "Furniture"])
        res = self._decide("approve")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment", "Furniture"])
        self.assertEqual(self.supplier.business_type, "IT Equipment, Furniture")
        self.assertIsNone(self.supplier.pending_business_types)
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.NONE)
        self.assertTrue(AuditLog.objects.filter(action="supplier.category_change_approved").exists())
        self.assertTrue(self.supplier.user.notifications.filter(message__contains="approved").exists())
        self.assertEqual(self._can_see_furniture(), (True, status.HTTP_200_OK))

    def test_rejection_keeps_the_approved_set_and_grants_nothing(self):
        self._request(["IT Equipment", "Furniture"])
        res = self._decide("reject", note="No furniture permits on file")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment"])
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.REJECTED)
        self.assertEqual(self.supplier.category_request_note, "No furniture permits on file")
        self.assertTrue(AuditLog.objects.filter(action="supplier.category_change_rejected").exists())
        self.assertEqual(self._can_see_furniture(), (False, status.HTTP_404_NOT_FOUND))
        # A rejected request can't be approved afterwards, but a new one can be filed.
        self.assertEqual(self._decide("approve").status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self._request(["IT Equipment", "Furniture"]).data["category_request_status"], "pending")

    def test_removal_waits_for_approval_too(self):
        self.supplier.business_types = ["IT Equipment", "Furniture"]
        self.supplier.save()
        self._request(["IT Equipment"])
        self.assertEqual(self._can_see_furniture()[0], True)    # still active while pending
        self._decide("approve")
        self.assertEqual(self._can_see_furniture()[0], False)

    def test_resending_the_approved_set_withdraws_the_request(self):
        self._request(["IT Equipment", "Furniture"])
        self._request(["IT Equipment"])
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.NONE)
        self.assertIsNone(self.supplier.pending_business_types)
        self.assertTrue(AuditLog.objects.filter(action="supplier.category_change_withdrawn").exists())

    def test_only_an_admin_can_decide(self):
        self._request(["IT Equipment", "Furniture"])
        other = make_supplier(verified=True)
        for user in (self.supplier.user, other.user, self.head):
            for decision in ("approve", "reject"):
                with self.subTest(user=user.username, decision=decision):
                    self.assertEqual(self._decide(decision, user=user).status_code, status.HTTP_403_FORBIDDEN)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment"])
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.post(f"/api/suppliers/{self.supplier.pk}/approve-categories/").status_code,
                         status.HTTP_401_UNAUTHORIZED)

    def test_deciding_without_a_pending_request_is_refused(self):
        for decision in ("approve", "reject"):
            with self.subTest(decision=decision):
                self.assertEqual(self._decide(decision).status_code, status.HTTP_400_BAD_REQUEST)

    def test_request_state_cannot_be_forged_through_the_api(self):
        self.client.force_authenticate(user=self.supplier.user)
        self.client.patch("/api/suppliers/me/", {
            "pending_business_types": ["Furniture"], "category_request_status": "pending",
        }, format="json")
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.NONE)
        # Filing a request and then trying to clear its status in the same call.
        self.client.patch("/api/suppliers/me/", {
            "business_types": ["IT Equipment", "Furniture"], "category_request_status": "",
        }, format="json")
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.PENDING)
        self.assertEqual(self.supplier.business_types, ["IT Equipment"])
        # The Admin's generic edit route is gone (H3), so it can't be used either.
        self.client.force_authenticate(user=self.admin)
        res = self.client.patch(f"/api/suppliers/{self.supplier.pk}/", {"business_types": ["Furniture"]},
                                format="json")
        self.assertEqual(res.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_an_invalid_request_changes_nothing_at_all(self):
        self.client.force_authenticate(user=self.supplier.user)
        for bad in ([], ["Not A Real Category"], "Furniture", [1, 2]):
            with self.subTest(bad=bad):
                res = self.client.patch("/api/suppliers/me/",
                                        {"business_types": bad, "full_name": "Changed Name"}, format="json")
                self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.supplier.refresh_from_db()
        self.supplier.user.refresh_from_db()
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.NONE)
        self.assertNotEqual(self.supplier.user.full_name, "Changed Name")

    def test_unverified_supplier_updates_categories_directly(self):
        pending = make_supplier(verified=False, categories=["IT Equipment"])
        res = self._request(["Furniture"], user=pending.user)
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        pending.refresh_from_db()
        self.assertEqual(pending.business_types, ["Furniture"])
        self.assertEqual(pending.category_request_status, Supplier.CategoryRequest.NONE)
        self.assertTrue(AuditLog.objects.filter(action="supplier.categories_updated",
                                                entity_id=str(pending.pk)).exists())

    def test_contact_details_still_save_without_touching_categories(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"phone_number": "09170000000"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.phone_number, "09170000000")
        self.assertEqual(self.supplier.category_request_status, Supplier.CategoryRequest.NONE)
        self.assertFalse(AuditLog.objects.filter(action__startswith="supplier.categor").exists())


class SupplierCategoryMigrationTests(TransactionTestCase):
    """0018 must preserve every existing supplier's approved categories and
    leave them with no pending request — forwards AND backwards."""

    BEFORE = [("procurement", "0017_bid_product_images")]
    AFTER = [("procurement", "0018_supplier_category_change_request")]

    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_existing_suppliers_survive_forward_and_backward(self):
        old = self._migrate(self.BEFORE)
        OldUser = old.get_model("accounts", "User")
        OldSupplier = old.get_model("procurement", "Supplier")
        user = OldUser.objects.create(username="legacy@example.com", email="legacy@example.com", role="supplier")
        rows = {
            "verified": OldSupplier.objects.create(
                user=user, company="Legacy Verified", contact="x", business_type="IT Equipment, Furniture",
                business_types=["IT Equipment", "Furniture"], qualification_status="verified"),
            "pending": OldSupplier.objects.create(
                company="Legacy Pending", contact="y", business_types=["Construction"]),
            "empty": OldSupplier.objects.create(company="Legacy Empty", contact="z", business_types=[]),
        }

        new = self._migrate(self.AFTER)
        NewSupplier = new.get_model("procurement", "Supplier")
        for key, before in rows.items():
            with self.subTest(row=key):
                after = NewSupplier.objects.get(pk=before.pk)
                self.assertEqual(after.business_types, before.business_types)
                self.assertEqual(after.qualification_status, before.qualification_status)
                self.assertEqual(after.category_request_status, "")
                self.assertIsNone(after.pending_business_types)
                self.assertEqual(after.category_request_note, "")
                self.assertIsNone(after.category_requested_at)

        # A row inserted WITHOUT the new columns (as the previous release does
        # while migrate runs on deploy) must still succeed — the DB defaults.
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO procurement_supplier (company, contact, business_type, status, "
                "qualification_status, email_verified, registered, company_address, phone_number, tin, "
                "representative_name, business_types, mayors_permit_expiry, tax_clearance_expiry, "
                "financial_statement_year, track_record_description, declaration_accepted, admin_notes, "
                "document_reviews, reviewed_at) VALUES ('Old Release Co', 'c', '', 'draft', "
                "'waiting_admin_approval', FALSE, '2026-10-20', '', '', '', '', '[]', NULL, NULL, NULL, '', FALSE, "
                "'', '{}', NULL)")
        self.assertEqual(NewSupplier.objects.get(company="Old Release Co").category_request_status, "")

        back = self._migrate(self.BEFORE)
        BackSupplier = back.get_model("procurement", "Supplier")
        self.assertEqual(BackSupplier.objects.get(pk=rows["verified"].pk).business_types,
                         ["IT Equipment", "Furniture"])


class PendingSupplierBidTests(APITestCase):
    """A supplier still awaiting approval who tried to bid was bounced to the
    login screen, which looked like being logged out. Being blocked must be a 403
    with a readable reason. A 401 would make the frontend clear the session."""

    def setUp(self):
        cache.clear()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.supplier = make_supplier(verified=False)

    def test_pending_supplier_still_sees_matching_projects(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.get("/api/projects/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        data = res.json()
        rows = data["results"] if isinstance(data, dict) else data
        self.assertEqual([r["id"] for r in rows], [self.project.pk])

    def test_pending_supplier_bid_is_forbidden_not_unauthorized(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(f"/api/projects/{self.project.pk}/bid/", {"amount": 1000})
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn("pending admin approval", res.json()["detail"])
        self.assertFalse(Bid.objects.filter(supplier=self.supplier).exists())


class MissingFileAndMailLoggingTests(APITestCase):
    """Two production failures that left no trace: a supplier document whose
    file had been wiped from Render's ephemeral disk came back as a bare 404
    (indistinguishable from an access denial), and password reset emails were
    sent with fail_silently=True, so an SMTP error was swallowed before the
    logging line could run."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.supplier = make_supplier(verified=False)
        self.supplier.sec_dti_certificate = dummy_pdf("sec.pdf")
        self.supplier.save()

    def test_admin_gets_an_explanation_when_the_file_is_gone(self):
        f = self.supplier.sec_dti_certificate
        f.storage.delete(f.name)
        self.client.force_authenticate(user=self.admin)
        with self.assertLogs("procurement.files", level="WARNING"):
            res = self.client.get(f"/api/files/supplier/{self.supplier.pk}/sec_dti_certificate/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
        self.assertIn("missing from storage", res.json()["detail"])

    def test_outsider_still_gets_a_bare_404(self):
        f = self.supplier.sec_dti_certificate
        f.storage.delete(f.name)
        rival = make_supplier()
        self.client.force_authenticate(user=rival.user)
        res = self.client.get(f"/api/files/supplier/{self.supplier.pk}/sec_dti_certificate/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
        self.assertNotIn("missing from storage", res.content.decode())

    def test_password_reset_smtp_failure_is_logged_not_swallowed(self):
        with mock.patch("django.core.mail.backends.locmem.EmailBackend.send_messages",
                        side_effect=OSError("smtp blocked")):
            with self.assertLogs("accounts.views", level="ERROR"):
                res = self.client.post("/api/auth/password/reset/",
                                       {"email": self.supplier.user.email})
        # Not 200: answering "link sent" here is what hid the production outage.
        self.assertEqual(res.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)


class MailOutageIsReportedTests(APITestCase):
    """Production answered "a reset link has been sent" while Brevo refused every
    SMTP login (535), so the failure was visible only in the server log."""

    REFUSED = "django.core.mail.backends.locmem.EmailBackend.open"

    def setUp(self):
        cache.clear()
        self.supplier = make_supplier(verified=False)

    def _reset(self, email):
        return self.client.post("/api/auth/password/reset/", {"email": email})

    def test_outage_gets_the_same_answer_for_known_and_unknown_addresses(self):
        with mock.patch(self.REFUSED, side_effect=OSError("535 Authentication failed")):
            with self.assertLogs("accounts.emails", level="ERROR"):
                known = self._reset(self.supplier.user.email)
            cache.clear()
            with self.assertLogs("accounts.emails", level="ERROR"):
                unknown = self._reset("nobody-here@example.com")
        self.assertEqual(known.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(unknown.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(known.data, unknown.data)
        self.assertEqual(len(mail.outbox), 0)

    def test_healthy_mail_keeps_the_generic_answer_for_both(self):
        known = self._reset(self.supplier.user.email)
        unknown = self._reset("nobody-here@example.com")
        self.assertEqual(known.status_code, status.HTTP_200_OK)
        self.assertEqual(known.data, unknown.data)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.supplier.user.email])

    @override_settings(EMAIL_BACKEND="django.core.mail.backends.console.EmailBackend")
    def test_console_backend_in_production_is_not_treated_as_sent(self):
        with self.assertLogs("accounts.emails", level="ERROR"):
            res = self._reset(self.supplier.user.email)
        self.assertEqual(res.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    def test_registration_survives_a_failed_verification_email_and_says_so(self):
        payload = {
            "full_name": "Jane Dela Cruz", "email": "new.supplier@example.com",
            "password": "Sup3rSecret!9", "confirm_password": "Sup3rSecret!9",
            "company_name": "Acme Trading Corp.", "company_address": "123 Rizal St, Manila",
            "phone_number": "09171234567", "tin": "123-456-789",
            "representative_name": "Jane Dela Cruz", "business_types": '["IT Equipment"]',
            "declaration_accepted": "true",
        }
        for key in ("sec_dti_certificate", "mayors_permit", "philgeps_certificate", "valid_id",
                    "tax_clearance_certificate", "audited_financial_statements",
                    "bank_reference_letter", "authorization_letter"):
            payload[key] = dummy_pdf(f"{key}.pdf")
        with mock.patch("accounts.emails.send_mail", side_effect=OSError("smtp blocked")):
            with self.assertLogs("accounts.emails", level="ERROR"):
                res = self.client.post("/api/auth/register/supplier/", payload, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        self.assertIs(res.data["verification_email_sent"], False)
        self.assertTrue(Supplier.objects.filter(user__email="new.supplier@example.com").exists())

    def test_rate_limit_message_is_readable(self):
        for _ in range(5):
            self._reset("nobody-here@example.com")
        res = self._reset("nobody-here@example.com")
        self.assertEqual(res.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertIn("Too many attempts", res.data["detail"])
        self.assertNotIn("throttled", res.data["detail"])


class SupplierResubmitGuardTests(APITestCase):
    """resubmit accepted ANY document key, so a supplier could replace a file
    the Admin had already accepted; and it ran for a VERIFIED supplier too,
    sending them back to pending (no bidding) with no review requested."""

    def setUp(self):
        cache.clear()
        self.supplier = make_supplier(verified=False)
        self.supplier.valid_id = dummy_pdf("id.pdf")
        self.supplier.mayors_permit = dummy_pdf("permit.pdf")
        self.supplier.qualification_status = Supplier.Qualification.NEEDS_REVISION
        self.supplier.document_reviews = {
            "valid_id": {"status": "needs_revision", "note": "Blurry"},
            "mayors_permit": {"status": "approved", "note": ""},
        }
        self.supplier.save()
        self.client.force_authenticate(user=self.supplier.user)

    def test_unflagged_document_is_refused(self):
        res = self.client.post("/api/suppliers/resubmit/",
                               {"mayors_permit": dummy_pdf("swap.pdf")}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.NEEDS_REVISION)

    def test_flagged_document_is_accepted(self):
        res = self.client.post("/api/suppliers/resubmit/",
                               {"valid_id": dummy_pdf("id2.pdf")}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.PENDING)
        self.assertEqual(self.supplier.document_reviews["valid_id"]["status"], "resubmitted")

    def test_a_flagged_category_document_is_resubmitted_through_the_same_endpoint(self):
        self.supplier.business_types = ["Medical Supplies"]
        self.supplier.document_reviews["fda_lto"] = {"status": "needs_revision", "note": "Expired"}
        self.supplier.save()
        res = self.client.post("/api/suppliers/resubmit/",
                               {"fda_lto": dummy_pdf("lto.pdf"), "fda_lto_expiry": IN_TWO_YEARS},
                               format="multipart")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        row = SupplierCategoryDocument.objects.get(supplier=self.supplier, key="fda_lto")
        self.assertEqual(str(row.expiry_date), IN_TWO_YEARS)

    def test_supplier_not_in_revision_cannot_resubmit(self):
        self.supplier.qualification_status = Supplier.Qualification.VERIFIED
        self.supplier.save(update_fields=["qualification_status"])
        res = self.client.post("/api/suppliers/resubmit/",
                               {"valid_id": dummy_pdf("id2.pdf")}, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)


class SupplierCategoryDocumentAccessTests(APITestCase):
    """Category licenses go through the same protected file view as every other
    document: kind "supplierdoc", field "file", strict allow-list, signed links."""

    def setUp(self):
        cache.clear()
        self.owner = make_supplier(categories=["Medical Supplies"])
        self.rival = make_supplier()
        self.row = SupplierCategoryDocument.objects.create(
            supplier=self.owner, key="fda_lto", file=dummy_pdf("lto.pdf"), expiry_date=IN_A_YEAR)
        self.path = f"/api/files/supplierdoc/{self.row.pk}/file/"

    def test_serializer_emits_a_protected_supplierdoc_url(self):
        self.client.force_authenticate(user=self.owner.user)
        res = self.client.get("/api/suppliers/me/")
        doc = next(d for d in res.data["documents"] if d["key"] == "fda_lto")
        self.assertIn("/api/files/supplierdoc/", doc["url"])
        self.assertEqual(self.client.get(doc["url"]).status_code, status.HTTP_200_OK)
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(doc["url"]).status_code, status.HTTP_404_NOT_FOUND)

    def test_owner_can_read(self):
        self.client.force_authenticate(user=self.owner.user)
        self.assertEqual(self.client.get(self.path).status_code, status.HTTP_200_OK)

    def test_rival_supplier_cannot_read(self):
        self.client.force_authenticate(user=self.rival.user)
        self.assertEqual(self.client.get(self.path).status_code, status.HTTP_404_NOT_FOUND)

    def test_admin_can_read_but_head_cannot(self):
        # The Head never reviews supplier registrations.
        self.client.force_authenticate(user=make_admin())
        self.assertEqual(self.client.get(self.path).status_code, status.HTTP_200_OK)
        self.client.force_authenticate(user=make_head())
        self.assertEqual(self.client.get(self.path).status_code, status.HTTP_404_NOT_FOUND)

    def test_an_unlisted_field_cannot_be_addressed(self):
        self.client.force_authenticate(user=make_admin())
        res = self.client.get(f"/api/files/supplierdoc/{self.row.pk}/key/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)


class SupplierCategoryDocumentMigrationTests(TransactionTestCase):
    """0019 only ADDS a table: existing suppliers are untouched forwards and
    backwards, and the previous release (which knows nothing of the table) can
    keep inserting suppliers while migrate runs."""

    BEFORE = [("procurement", "0018_supplier_category_change_request")]
    AFTER = [("procurement", "0019_supplier_category_document")]

    def _migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())

    def test_existing_suppliers_survive_forward_and_backward(self):
        old = self._migrate(self.BEFORE)
        OldSupplier = old.get_model("procurement", "Supplier")
        verified = OldSupplier.objects.create(
            company="Legacy Medical", contact="x", business_types=["Medical Supplies"],
            qualification_status="verified", document_reviews={"valid_id": {"status": "approved", "note": ""}})

        new = self._migrate(self.AFTER)
        NewSupplier = new.get_model("procurement", "Supplier")
        Row = new.get_model("procurement", "SupplierCategoryDocument")
        after = NewSupplier.objects.get(pk=verified.pk)
        self.assertEqual(after.business_types, ["Medical Supplies"])
        self.assertEqual(after.qualification_status, "verified")
        self.assertEqual(after.document_reviews, verified.document_reviews)
        self.assertEqual(Row.objects.count(), 0)
        Row.objects.create(supplier_id=after.pk, key="fda_lto", file="supplier_docs/1/lto.pdf")

        back = self._migrate(self.BEFORE)
        BackSupplier = back.get_model("procurement", "Supplier")
        self.assertEqual(BackSupplier.objects.get(pk=verified.pk).qualification_status, "verified")
        self.assertNotIn("procurement_suppliercategorydocument", connection.introspection.table_names())


class ReissuedAwardDocumentVerificationTests(APITestCase):
    """Re-issuing an award document (generate the draft, then upload the signed
    copy — the flow the Awards page encourages) overwrote the document and its
    *_issued_at. verify_anchor rebuilt the OLDER anchor from that live record,
    got the new issue date, and reported an honest procurement as "altered" on
    the public verifier. The older anchor must read "superseded" instead, while
    a real edit (the award amount) is still caught on every anchor."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.winner = make_supplier()
        self.bid = qualified_bid(self.project, self.winner, 1000)
        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{self.bid.pk}/select-winner/")
        self.award = Award.objects.get(project=self.project)

    def _reissue_noa(self):
        res = self.client.post(f"/api/awards/{self.award.pk}/documents/generate/",
                               {"key": "notice_of_award"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        res = self.client.post(f"/api/awards/{self.award.pk}/documents/",
                               {"key": "notice_of_award", "file": dummy_pdf("signed-noa.pdf")},
                               format="multipart")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        return list(BlockchainAnchor.objects.filter(
            stage=BlockchainAnchor.Stage.NOA_ISSUED).order_by("id"))

    def _public_trail(self, deep=False):
        url = f"/api/public/procurement/{self.project.code}/anchors/" + ("?deep=1" if deep else "")
        self.client.force_authenticate(user=None)
        res = self.client.get(url)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        return res.data

    def test_older_issue_is_superseded_and_latest_matches(self):
        older, latest = self._reissue_noa()
        data = self._public_trail(deep=True)
        by_hash = {a["data_hash"]: a for a in data["anchors"]}
        self.assertEqual(by_hash[older.data_hash]["integrity"]["status"], "superseded")
        self.assertEqual(by_hash[latest.data_hash]["integrity"]["status"], "match")
        self.assertEqual(data["altered_count"], 0)

    def test_editing_the_award_amount_is_still_caught_on_both_issues(self):
        older, latest = self._reissue_noa()
        Award.objects.filter(pk=self.award.pk).update(amount=1)
        by_hash = {a["data_hash"]: a for a in self._public_trail()["anchors"]}
        self.assertEqual(by_hash[older.data_hash]["integrity"]["status"], "mismatch")
        self.assertEqual(by_hash[latest.data_hash]["integrity"]["status"], "mismatch")

    def test_editing_the_old_anchor_snapshot_is_caught(self):
        older, _ = self._reissue_noa()
        payload = dict(older.payload)
        payload["issued_at"] = "2020-01-01T00:00:00+00:00"   # someone "backdates" the old notice
        BlockchainAnchor.objects.filter(pk=older.pk).update(payload=payload)
        by_hash = {a["data_hash"]: a for a in self._public_trail()["anchors"]}
        self.assertEqual(by_hash[older.data_hash]["integrity"]["status"], "mismatch")


class SelectWinnerAnchorSequenceTests(APITestCase):
    """select_winner created the winning BID_SUBMITTED anchor and the AWARDED
    anchor but returned only the latter, so in the MetaMask flow the bid's
    anchor was never offered for signing."""

    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PUBLISHED)
        self.bid = qualified_bid(self.project, make_supplier(), 1000)
        self.client.force_authenticate(user=self.admin)

    def test_response_carries_every_anchor_in_signing_order(self):
        res = self.client.post(f"/api/bids/{self.bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK, res.data)
        stages = [a["stage"] for a in res.data["anchor_sequence"]]
        self.assertEqual(stages[-2:], ["BID_SUBMITTED", "AWARDED"])
        # Older clients still read `anchor`.
        self.assertEqual(res.data["anchor"]["stage"], "AWARDED")
        for a in res.data["anchor_sequence"]:
            self.assertTrue(a["attach_url"])
            self.assertFalse(a["anchored"])


class ConfirmationNeverErasesWhatItCannotSeeTests(APITestCase):
    """Two ways a genuine anchor could lose its tx hash because of the NODE,
    not the chain (found while adding on-chain identity, Stage 2)."""

    LEDGER = "0x" + "12" * 20
    TX = "0x" + "ab" * 32

    def setUp(self):
        patcher = mock.patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", self.LEDGER)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _anchor(self, **fields):
        from datetime import timedelta
        from django.utils import timezone
        return BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref="PRC-2026-976X-TVMX", stage="SUBMITTED",
            data_hash="0x" + "cd" * 32, tx_hash=self.TX,
            anchored_at=timezone.now() - timedelta(days=90), **fields)

    def test_an_unreadable_ledger_state_is_not_read_as_dropped(self):
        # Old tx unknown to a pruned node, AND the getAnchorsByRef fallback
        # errors: _ledger_holds used to return False ("not there") and the
        # genuine tx hash was cleared as DROPPED.
        from .blockchain import confirm_anchor
        from .tests import sepolia_node
        anchor = self._anchor()
        w3 = sepolia_node(receipt_missing=True, tx_known=False)
        w3.eth.contract.return_value.functions.getAnchorsByRef.side_effect = ConnectionError("rpc down")
        self.assertEqual(confirm_anchor(anchor, w3=w3), "unknown")
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, self.TX)
        self.assertFalse(AuditLog.objects.filter(action="blockchain.dropped").exists())

    def test_a_confirmed_anchor_is_not_downgraded_when_its_receipt_is_pruned(self):
        # Anchors confirmed before Stage 2 have no on-chain identity yet and
        # are re-read to fill it in. On the default (pruning) RPC the receipt
        # is gone: that must leave the earlier confirmation exactly as it was.
        from .blockchain import confirm_anchor
        from .tests import sepolia_node
        anchor = self._anchor(chain_status=BlockchainAnchor.ChainStatus.CONFIRMED, block_number=9_100_000)
        w3 = sepolia_node(receipt_missing=True, tx_known=False)
        w3.eth.contract.return_value.functions.getAnchorsByRef.return_value.call.return_value = []
        self.assertEqual(confirm_anchor(anchor, w3=w3), "unknown")
        anchor.refresh_from_db()
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.CONFIRMED)
        self.assertEqual((anchor.tx_hash, anchor.block_number), (self.TX, 9_100_000))
        self.assertIsNone(anchor.chain_anchor_id)        # nothing invented


class PublicAwardDateTests(APITestCase):
    """The public procurement detail returned the exact Project.awarded_at, to the
    microsecond. Only the date is public; the exact time stays internal, for the
    private commitment and for signed-in viewers."""

    def _award(self, at):
        from unittest.mock import patch as _patch
        cache.clear()
        self.project = make_project(status=Project.Status.PUBLISHED)
        bid = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=900,
                                 status=Bid.Status.QUALIFIED)
        self.admin = User.objects.filter(username="admin").first() or make_admin()
        self.client.force_authenticate(user=self.admin)
        with _patch("django.utils.timezone.now", return_value=at):
            self.assertEqual(self.client.post(f"/api/bids/{bid.pk}/select-winner/").status_code, 200)
        self.project.refresh_from_db()
        self.client.force_authenticate(user=None)

    def _public(self):
        res = self.client.get(f"/api/public/procurement/{self.project.code}/")
        self.assertEqual(res.status_code, 200)
        return res

    def test_the_public_detail_shows_the_date_and_no_time(self):
        self._award(datetime(2026, 11, 3, 9, 15, 42, 654321, tzinfo=dt_timezone.utc))
        res = self._public()
        self.assertEqual(res.json()["result"]["awarded_at"], "2026-11-03")
        body = res.content.decode("utf-8")
        for fragment in ("09:15", "17:15", "42.654321", "654321", "2026-11-03T"):
            self.assertNotIn(fragment, body)

    def test_the_date_is_the_philippine_date_late_in_the_utc_day(self):
        self._award(datetime(2026, 11, 3, 17, 30, 0, 654321, tzinfo=dt_timezone.utc))
        self.assertEqual(self._public().json()["result"]["awarded_at"], "2026-11-04")

    def test_an_award_with_no_exact_time_falls_back_to_its_date(self):
        self._award(datetime(2026, 11, 3, 9, 15, tzinfo=dt_timezone.utc))
        Project.objects.filter(pk=self.project.pk).update(awarded_at=None)
        Award.objects.filter(project=self.project).update(awarded_at="2026-01-15")
        self.assertEqual(self._public().json()["result"]["awarded_at"], "2026-01-15")

    def test_the_exact_time_stays_authoritative_internally(self):
        at = datetime(2026, 11, 3, 17, 30, 0, 654321, tzinfo=dt_timezone.utc)
        self._award(at)
        self._public()
        self.project.refresh_from_db()
        self.assertEqual(self.project.awarded_at, at)
        self.client.force_authenticate(user=self.admin)
        record = self.client.get(f"/api/projects/{self.project.pk}/record/").json()
        self.assertEqual(record["result"]["awarded_at"], "2026-11-03T17:30:00.654321Z")

    def test_the_v2_award_anchors_still_verify(self):
        self._award(datetime(2026, 11, 3, 17, 30, tzinfo=dt_timezone.utc))
        self._public()
        anchors = BlockchainAnchor.objects.filter(entity_ref=self.project.code)
        self.assertEqual(anchors.count(), 3)
        for anchor in anchors:
            self.assertEqual(anchor.payload["v"], 2)
            self.assertEqual(verify_anchor(anchor, deep=True)["status"], "match")


class PayloadVersionDispatchTests(APITestCase):
    """Stage 5 Phase 1 (finding F4): every anchor is verified with the builders
    of ITS OWN payload version.

    Before PAYLOAD_RULES, verify_anchor rebuilt every anchor with the CURRENT
    builders and chose the v1 compatibility path with `v < PAYLOAD_VERSION`.
    The day a new payload shape was introduced, every existing v2 anchor would
    have been rebuilt in the new shape and reported as altered — honest records
    on Sepolia turning red, with nothing on-chain able to fix it. These tests
    register a stand-in "v3" with a different shape, switch the writer to it,
    and require every older anchor to verify exactly as before."""

    def setUp(self):
        import shutil
        import tempfile
        cache.clear()
        media = tempfile.mkdtemp()
        override = override_settings(MEDIA_ROOT=media)
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)

        self.admin, self.head = make_admin(), make_head()
        self.project = make_project(status=Project.Status.PENDING_HEAD)
        self.v1_anchor = self._write_v1_anchor()
        # A whole lifecycle under today's writer (v2): Head approval and
        # publication, then the award (evaluation commitment, winning bid,
        # AWARDED), then a Notice of Award issued twice (one superseded).
        self.client.force_authenticate(user=self.head)
        self.assertEqual(self.client.post(f"/api/projects/{self.project.pk}/approve/").status_code, 200)
        self.client.force_authenticate(user=self.admin)
        self.assertEqual(self.client.post(f"/api/projects/{self.project.pk}/publish/").status_code, 200)
        win = Bid.objects.create(project=self.project, supplier=make_supplier(), amount=50000,
                                 status=Bid.Status.QUALIFIED)
        Bid.objects.create(project=self.project, supplier=make_supplier(), amount=60000,
                           status=Bid.Status.QUALIFIED)
        self.assertEqual(self.client.post(f"/api/bids/{win.pk}/select-winner/").status_code, 200)
        self.award = Award.objects.get(project=self.project)
        self.assertEqual(self.client.post(f"/api/awards/{self.award.pk}/documents/generate/",
                                          {"key": "notice_of_award"}, format="json").status_code, 200)
        signed = SimpleUploadedFile("signed-noa.pdf", b"%PDF-1.4 signed notice", content_type="application/pdf")
        self.assertEqual(self.client.post(f"/api/awards/{self.award.pk}/documents/",
                                          {"key": "notice_of_award", "file": signed},
                                          format="multipart").status_code, 200)
        self.anchors = list(BlockchainAnchor.objects.filter(entity_ref=self.project.code).order_by("id"))

    def _write_v1_anchor(self):
        payload = {
            "v": 1, "entity": "PROJECT", "stage": "SUBMITTED", "code": self.project.code,
            "name": self.project.name, "category": self.project.category or "",
            "type": self.project.type or "", "budget": f"{self.project.budget:.2f}",
            "status": self.project.status,
            "bidding_period_days": self.project.bidding_period_days or 0,
            "delivery_period_days": self.project.delivery_period_days or 0,
            "deadline": "", "created_at": self.project.created_at.isoformat(),
            "reviewed_at": "", "published_at": "", "document_hash": "",
        }
        return BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
            stage="SUBMITTED", data_hash=hash_payload(payload), payload=payload)

    @staticmethod
    def _fake_v3():
        """A stand-in for a future payload module: the v2 shape plus a field
        v2 never had, under v3. Enough to make a rebuild in the wrong shape fail."""
        from types import SimpleNamespace

        from . import payload_v2

        def tagged(builder):
            return lambda *args, **kwargs: {**builder(*args, **kwargs), "v": 3, "kind": "stand-in/3"}

        return SimpleNamespace(
            project_payload=tagged(payload_v2.project_payload),
            bid_payload=tagged(payload_v2.bid_payload),
            award_payload=tagged(payload_v2.award_payload),
            evaluation_payload=tagged(payload_v2.evaluation_payload),
            bid_leaf_fields=payload_v2.bid_leaf_fields,
            iso=payload_v2.iso,
            REISSUE_KEYS=payload_v2.REISSUE_KEYS,
        )

    @contextlib.contextmanager
    def _newer_version_written(self):
        from . import blockchain
        with mock.patch.dict(blockchain.PAYLOAD_RULES, {3: blockchain.PayloadRules(3, self._fake_v3())}), \
                mock.patch.object(blockchain, "PAYLOAD_VERSION", 3):
            yield

    def _results(self):
        return {a.id: (a.stage, verify_anchor(a, deep=True)["status"]) for a in self.anchors}

    def test_the_lifecycle_covers_every_kind_of_anchor(self):
        stages = [a.stage for a in self.anchors]
        for stage in ("SUBMITTED", "HEAD_APPROVED", "BIDDING_OPEN", "EVALUATION_COMPLETED",
                      "BID_SUBMITTED", "AWARDED", "NOA_ISSUED"):
            self.assertIn(stage, stages)
        self.assertEqual(stages.count("NOA_ISSUED"), 2)
        self.assertEqual({(a.payload or {}).get("v") for a in self.anchors}, {1, 2})

    def test_old_anchors_verify_the_same_after_a_newer_version_is_introduced(self):
        before = self._results()
        self.assertEqual(before[self.v1_anchor.id], ("SUBMITTED", "match"))
        self.assertTrue(all(status_ in ("match", "superseded") for _, status_ in before.values()), before)
        self.assertIn("superseded", [status_ for _, status_ in before.values()])
        with self._newer_version_written():
            self.assertEqual(self._results(), before)

    def test_new_anchors_are_written_and_verified_in_the_newer_version(self):
        # The registry works in both directions: today's writer can move on
        # while yesterday's anchors keep their own rules.
        fresh = make_project(status=Project.Status.PENDING_HEAD)
        self.client.force_authenticate(user=self.head)
        with self._newer_version_written():
            res = self.client.post(f"/api/projects/{fresh.pk}/approve/")
            anchor = BlockchainAnchor.objects.get(pk=res.data["anchor"]["id"])
            self.assertEqual((anchor.payload["v"], anchor.payload["kind"]), (3, "stand-in/3"))
            self.assertEqual(verify_anchor(anchor)["status"], "match")
        # Without rules for v3, the same anchor is "can't check here", not "altered".
        result = verify_anchor(anchor)
        self.assertEqual((result["status"], result["record"]), ("unavailable", "unavailable"))
        self.assertIn("payload version 3", result["detail"])

    def test_tampering_is_still_caught_with_a_newer_version_registered(self):
        with self._newer_version_written():
            Project.objects.filter(pk=self.project.pk).update(budget=1)
            Award.objects.filter(pk=self.award.pk).update(amount=1)
            results = self._results()
        by_stage = {}
        for stage, status_ in results.values():
            by_stage.setdefault(stage, set()).add(status_)
        # v1 and v2, current and superseded issues alike.
        for stage in ("SUBMITTED", "HEAD_APPROVED", "BIDDING_OPEN", "AWARDED", "NOA_ISSUED"):
            self.assertEqual(by_stage[stage], {"mismatch"}, stage)

    def test_unknown_or_malformed_versions_are_unavailable_never_altered(self):
        template = next(a for a in self.anchors if a.stage == "HEAD_APPROVED").payload
        for version in (4, 0, -1, "2", 2.0, True, None, [2]):
            with self.subTest(version=version):
                payload = {**template, "v": version}
                anchor = BlockchainAnchor.objects.create(
                    entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
                    stage="HEAD_APPROVED", data_hash=hash_payload(payload), payload=payload)
                result = verify_anchor(anchor, deep=True)
                self.assertEqual((result["status"], result["record"]), ("unavailable", "unavailable"))
                self.assertIn("payload version", result["detail"])

    def test_a_payload_without_a_version_is_still_version_1(self):
        payload = {k: v for k, v in self.v1_anchor.payload.items() if k != "v"}
        anchor = BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
            stage="SUBMITTED", data_hash=hash_payload(payload), payload=payload)
        self.assertEqual(verify_anchor(anchor)["status"], "match")

    def test_todays_writer_is_unchanged(self):
        from . import blockchain, canonical
        self.assertEqual(blockchain.PAYLOAD_VERSION, 2)
        self.assertIs(blockchain.hash_payload, canonical.hash_payload)
        self.assertEqual({a.payload["v"] for a in self.anchors if a.id != self.v1_anchor.id}, {2})
        for anchor in self.anchors:   # every stored payload still reproduces its anchored hash
            self.assertEqual(hash_payload(anchor.payload), anchor.data_hash, anchor.stage)

    def test_an_inclusion_receipt_for_an_unsupported_version_is_withheld(self):
        from .blockchain import inclusion_receipt
        evaluation = next(a for a in self.anchors if a.stage == "EVALUATION_COMPLETED")
        bid = Bid.objects.filter(project=self.project).first()
        self.assertIsNotNone(inclusion_receipt(bid))
        BlockchainAnchor.objects.filter(pk=evaluation.pk).update(payload={**evaluation.payload, "v": 9})
        self.assertIsNone(inclusion_receipt(bid))

    def _project_anchor(self, payload, data_hash=None, stage="HEAD_APPROVED"):
        return BlockchainAnchor.objects.create(
            entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
            stage=stage, payload=payload,
            data_hash=data_hash or hash_payload(payload))

    def test_a_non_object_payload_is_unavailable_never_altered(self):
        # Whether or not it happens to reproduce the anchored hash, a stored
        # payload that is not a JSON object can't be interpreted, so it is
        # never reported as altered.
        for payload in (["x"], [{"v": 2}], "a string", 5, 2.5, True):
            for data_hash in (None, "0x" + "00" * 32):
                with self.subTest(payload=payload, hash_consistent=data_hash is None):
                    result = verify_anchor(self._project_anchor(payload, data_hash), deep=True)
                    self.assertEqual((result["status"], result["record"]), ("unavailable", "unavailable"))
                    self.assertIn("not a JSON object", result["detail"])

    def test_a_genuinely_different_json_object_is_still_a_mismatch(self):
        approved = next(a for a in self.anchors if a.stage == "HEAD_APPROVED")
        # A v2 object whose anchored hash is not what the record hashes to.
        self.assertEqual(verify_anchor(self._project_anchor(dict(approved.payload), "0x" + "00" * 32))["status"],
                         "mismatch")
        # A v1 snapshot edited after anchoring: it no longer reproduces data_hash.
        edited = {**self.v1_anchor.payload, "budget": "1.00"}
        self.assertEqual(verify_anchor(self._project_anchor(edited, self.v1_anchor.data_hash, "SUBMITTED"))["status"],
                         "mismatch")
        # A valid v2 object, but the live record was changed.
        Project.objects.filter(pk=self.project.pk).update(name="Renamed after anchoring")
        self.assertEqual(verify_anchor(approved)["status"], "mismatch")

    def test_empty_payloads_keep_their_existing_result(self):
        # Unchanged from before Phase 1: with no stored snapshot nothing can be
        # proven, and these have always reported a mismatch. Unsaved anchors:
        # the column is NOT NULL, but verification must not depend on that.
        for payload in (None, {}, []):
            with self.subTest(payload=payload):
                anchor = BlockchainAnchor(
                    entity_type="PROJECT", entity_ref=self.project.code, entity_id=str(self.project.pk),
                    stage="HEAD_APPROVED", payload=payload, data_hash="0x" + "00" * 32)
                self.assertEqual(verify_anchor(anchor)["status"], "mismatch")

    def test_an_unsupported_writer_version_is_refused(self):
        from django.core.exceptions import ImproperlyConfigured

        from . import blockchain
        blockchain.check_writer_version(2, blockchain.PAYLOAD_RULES)    # today's: accepted
        with self.assertRaisesMessage(ImproperlyConfigured, "PAYLOAD_VERSION = 3 has no entry in PAYLOAD_RULES"):
            blockchain.check_writer_version(3, blockchain.PAYLOAD_RULES)

    def test_the_writer_version_check_runs_at_import_under_python_O(self):
        # `python -O` strips asserts; the startup check must not be one. In a
        # separate `-O` interpreter, import blockchain.py's own source with the
        # writer version set to 3 (in memory only — no file is changed) and
        # require the import itself to fail. Local SQLite only: DB_HOST is
        # blanked and the child calls itself a test run.
        import os
        import subprocess
        import sys
        from pathlib import Path

        from django.conf import settings
        child = "\n".join([
            "import sys, re, types",
            "sys.argv = ['manage.py', 'test']",
            "import django",
            "django.setup()",
            "from django.core.exceptions import ImproperlyConfigured",
            "src = open('procurement/blockchain.py', encoding='utf-8').read()",
            "src, n = re.subn(r'(?m)^PAYLOAD_VERSION = 2\\r?$', 'PAYLOAD_VERSION = 3', src)",
            "print('optimize', sys.flags.optimize, 'replaced', n)",
            "module = types.ModuleType('procurement._writer_version_probe')",
            "module.__package__ = 'procurement'",
            "try:",
            "    exec(compile(src, 'blockchain.py', 'exec'), module.__dict__)",
            "    print('IMPORTED')",
            "except ImproperlyConfigured as exc:",
            "    print('REFUSED', exc)",
        ])
        backend = Path(settings.BASE_DIR)
        env = {**os.environ, "DB_HOST": "", "DJANGO_SETTINGS_MODULE": "config.settings",
               "PYTHONPATH": str(backend), "PYTHONIOENCODING": "utf-8"}
        out = subprocess.run([sys.executable, "-O", "-c", child], cwd=backend, env=env,
                             capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("optimize 1 replaced 1", out.stdout)
        self.assertIn("REFUSED PAYLOAD_VERSION = 3 has no entry in PAYLOAD_RULES", out.stdout)
        self.assertNotIn("IMPORTED", out.stdout)


def fake_sepolia_node(on_send=None, on_estimate=None):
    """Real web3 and real signing against an in-memory node. Nothing leaves the
    process, and a node error goes through web3's own error handling, so these
    tests see the exceptions production would.

    `on_send(raw)` may raise, or return a JSON-RPC error dict, to act out a send.
    `node.sent` records what reached the node, so a lost reply still counts."""
    from web3 import Web3
    from web3.providers.base import BaseProvider

    class Node(BaseProvider):
        def make_request(self, method, params):
            error = None
            if method == "eth_sendRawTransaction":
                self.sent.append(bytes(Web3.to_bytes(hexstr=params[0])))
                error = self.on_send(self.sent[-1]) if self.on_send else None
                result = Web3.to_hex(Web3.keccak(self.sent[-1]))
            elif method == "eth_estimateGas":
                error = self.on_estimate() if self.on_estimate else None
                result = hex(1_267_576)
            else:
                result = {
                    "eth_chainId": hex(11155111), "eth_getTransactionCount": hex(16),
                    "eth_maxPriorityFeePerGas": hex(3), "eth_gasPrice": hex(23),
                    "eth_getBlockByNumber": {"number": hex(12_070_000), "baseFeePerGas": hex(20)},
                }[method]
            if error:
                return {"jsonrpc": "2.0", "id": 1, "error": error}
            return {"jsonrpc": "2.0", "id": 1, "result": result}

    node = Node()
    node.sent = []
    node.on_send, node.on_estimate = on_send, on_estimate
    return Web3(node), node


def node_says(message):
    return lambda *_: {"code": -32000, "message": message}


def raises(exc):
    def send(_raw):
        raise exc
    return send


class ServerSendTestBase:
    """Turns server signing on against a fake node. The key is a throwaway test
    value that has never held anything."""

    def _use_node(self, **behaviour):
        self.w3, self.node = fake_sepolia_node(**behaviour)
        for name, value in {
            "SERVER_SIGNING_ENABLED": True,
            "BLOCKCHAIN_PRIVATE_KEY": "0x" + "22" * 32,
            "LEDGER_CONTRACT_ADDRESS": "0x" + "12" * 20,
            "web3_client": lambda: self.w3,
        }.items():
            patcher = mock.patch(f"procurement.blockchain.{name}", value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _anchor(self, **fields):
        fields.setdefault("entity_ref", "PC-TEST-TEST-TEST")
        return BlockchainAnchor.objects.create(
            entity_type=BlockchainAnchor.EntityType.PROJECT,
            stage=BlockchainAnchor.Stage.SUBMITTED, data_hash="0x" + "cd" * 32, **fields)


class ServerSendNeverRepeatsTests(ServerSendTestBase, APITestCase):
    """An uncertain send must never turn into a second transaction: every extra
    one is a permanent duplicate record on the public ledger."""

    def setUp(self):
        self._use_node()
        self.project = make_project(status=Project.Status.PENDING_HEAD)
        self.client.force_authenticate(user=make_head())

    def _project_anchor(self):
        return self._anchor(entity_id=str(self.project.pk), entity_ref=self.project.code)

    def _retry(self, anchor):
        return self.client.post(
            f"/api/projects/{self.project.pk}/anchor/",
            {"anchor_id": anchor.pk, "server_submit": True}, format="json")

    def test_the_saved_hash_is_the_hash_of_what_reached_the_node(self):
        from web3 import Web3
        anchor = self._anchor()
        result = blockchain.submit_anchor_server_side(anchor)
        self.assertEqual(result.send_state, blockchain.SEND_SENT)
        self.assertEqual(len(self.node.sent), 1)
        self.assertEqual(anchor.tx_hash, Web3.to_hex(Web3.keccak(self.node.sent[0])))
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.UNCHECKED)

    def test_every_unclear_send_result_keeps_the_hash(self):
        import requests

        cases = {
            "reply timed out": raises(requests.exceptions.ReadTimeout("no reply")),
            "connection dropped": raises(requests.exceptions.ConnectionError("reset")),
            "unexpected error": raises(RuntimeError("anything else")),
            "unrecognised node error": node_says("something new the node invented"),
            # Our own transaction, mined, when web3 re-sends after a lost reply.
            "nonce too low": node_says("nonce too low: next nonce 17, tx nonce 16"),
        }
        for label, on_send in cases.items():
            with self.subTest(label):
                self.node.on_send = on_send
                self.node.sent.clear()
                anchor = self._anchor()
                result = blockchain.submit_anchor_server_side(anchor)
                self.assertEqual(result.send_state, blockchain.SEND_UNCERTAIN)
                anchor.refresh_from_db()
                self.assertTrue(anchor.tx_hash.startswith("0x"))
                # What stops the browser retrying on its own (anchorStore.runAnchor).
                summary = blockchain.anchor_summary(anchor)
                self.assertTrue(summary["anchored"])
                self.assertFalse(summary["can_reanchor"])
                self.assertFalse(summary["verified_on_chain"])
                self.assertEqual(len(self.node.sent), 1)
                self.assertTrue(AuditLog.objects.filter(
                    action="blockchain.send_uncertain", description__contains=anchor.tx_hash).exists())

    def test_a_lost_reply_is_not_sent_again_by_a_retry(self):
        import requests

        self.node.on_send = raises(requests.exceptions.ReadTimeout("no reply"))
        anchor = self._project_anchor()
        for _ in range(3):
            self.assertEqual(self._retry(anchor).status_code, status.HTTP_200_OK)
        self.assertEqual(len(self.node.sent), 1)
        self.assertFalse(AuditLog.objects.filter(action="blockchain.anchored").exists())

    def test_a_lost_reply_does_not_break_the_approval_or_invite_a_retry(self):
        import requests

        self.node.on_send = raises(requests.exceptions.ReadTimeout("no reply"))
        res = self.client.post(f"/api/projects/{self.project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.APPROVED)
        self.assertTrue(res.data["anchor"]["tx_hash"].startswith("0x"))
        self.assertFalse(res.data["anchor"]["can_reanchor"])
        self.assertEqual(len(self.node.sent), 1)

    def test_a_refused_send_can_be_retried_and_only_sends_once_more(self):
        for phrase in blockchain.NODE_REFUSALS:
            with self.subTest(phrase):
                self.node.on_send = node_says(phrase + " (detail)")
                self.node.sent.clear()
                anchor = self._project_anchor()
                self.assertEqual(self._retry(anchor).status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
                anchor.refresh_from_db()
                self.assertEqual(anchor.tx_hash, "")
                self.assertIsNone(anchor.anchored_at)
                self.assertEqual(anchor.actor_address, "")

                self.node.on_send = None
                self.assertEqual(self._retry(anchor).status_code, status.HTTP_200_OK)
                self._retry(anchor)
                self.assertEqual(len(self.node.sent), 2)

    def test_already_known_means_the_node_has_it(self):
        self.node.on_send = node_says("already known")
        anchor = self._anchor()
        result = blockchain.submit_anchor_server_side(anchor)
        self.assertEqual(result.send_state, blockchain.SEND_SENT)
        anchor.refresh_from_db()
        self.assertTrue(anchor.tx_hash.startswith("0x"))
        self.assertFalse(AuditLog.objects.filter(action="blockchain.send_uncertain").exists())

    def test_a_failure_before_signing_saves_nothing_and_stays_retryable(self):
        self.node.on_estimate = node_says("execution reverted")
        anchor = self._anchor()
        self.assertIsNone(blockchain.submit_anchor_server_side(anchor))
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, "")
        self.assertEqual(self.node.sent, [])

    def test_repeating_a_request_after_success_sends_nothing(self):
        anchor = self._project_anchor()
        first = self._retry(anchor)
        second = self._retry(anchor)
        self.assertEqual(first.data["tx_hash"], second.data["tx_hash"])
        self.assertEqual(len(self.node.sent), 1)
        self.assertEqual(AuditLog.objects.filter(action="blockchain.anchored").count(), 1)

    def test_a_request_that_loses_the_race_sends_nothing(self):
        # Both requests read an empty hash. The other one saves first, while this
        # one is still preparing its transaction.
        other = "0x" + "ef" * 32
        anchor = self._project_anchor()

        def other_request_wins():
            BlockchainAnchor.objects.filter(pk=anchor.pk).update(tx_hash=other)

        self.node.on_estimate = other_request_wins
        res = self._retry(anchor)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["tx_hash"], other)
        self.assertEqual(self.node.sent, [])
        self.assertFalse(AuditLog.objects.filter(action="blockchain.anchored").exists())

    def test_a_mismatched_transaction_can_still_be_replaced(self):
        old = "0x" + "aa" * 32
        anchor = self._project_anchor()
        BlockchainAnchor.objects.filter(pk=anchor.pk).update(
            tx_hash=old, chain_status=BlockchainAnchor.ChainStatus.MISMATCH)
        res = self._retry(anchor)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertNotEqual(res.data["tx_hash"], old)
        self.assertEqual(res.data["chain_status"], BlockchainAnchor.ChainStatus.UNCHECKED)
        self.assertEqual(len(self.node.sent), 1)

    def test_a_refused_replacement_restores_the_mismatch(self):
        old = "0x" + "aa" * 32
        self.node.on_send = node_says("insufficient funds")
        anchor = self._project_anchor()
        BlockchainAnchor.objects.filter(pk=anchor.pk).update(
            tx_hash=old, actor_address="0x" + "33" * 20, chain_status=BlockchainAnchor.ChainStatus.MISMATCH)
        self.assertEqual(self._retry(anchor).status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, old)
        self.assertEqual(anchor.actor_address, "0x" + "33" * 20)
        self.assertEqual(anchor.chain_status, BlockchainAnchor.ChainStatus.MISMATCH)


class ServerSendSurvivesAWorkerDyingTests(ServerSendTestBase, APITransactionTestCase):
    """A real commit, so these see what another connection would see. A killed
    worker runs no cleanup, and an open transaction would simply vanish with it."""

    def setUp(self):
        self._use_node()
        self.seen = []

        def record(_raw):
            self.seen.append((connection.in_atomic_block,
                              BlockchainAnchor.objects.order_by("-id").first().tx_hash))

        self.node.on_send = record

    def _assert_committed_before_send(self):
        self.assertEqual(len(self.seen), 1)
        in_transaction, saved_hash = self.seen[0]
        self.assertFalse(in_transaction)
        self.assertTrue(saved_hash.startswith("0x"))

    def test_the_automatic_send_commits_the_hash_first(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        self.client.force_authenticate(user=make_head())
        res = self.client.post(f"/api/projects/{project.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self._assert_committed_before_send()

    def test_the_anchor_now_send_commits_the_hash_first(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        anchor = self._anchor(entity_id=str(project.pk), entity_ref=project.code)
        self.client.force_authenticate(user=make_head())
        res = self.client.post(f"/api/projects/{project.pk}/anchor/",
                               {"anchor_id": anchor.pk, "server_submit": True}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self._assert_committed_before_send()

    def test_a_worker_dying_mid_send_leaves_the_hash_and_blocks_a_second_send(self):
        self.node.on_send = raises(SystemExit(1))
        anchor = self._anchor()
        with self.assertRaises(SystemExit):
            blockchain.submit_anchor_server_side(anchor)

        fresh = BlockchainAnchor.objects.get(pk=anchor.pk)
        self.assertTrue(fresh.tx_hash.startswith("0x"))
        summary = blockchain.anchor_summary(fresh)
        self.assertTrue(summary["anchored"])
        self.assertFalse(summary["can_reanchor"])


class RetryOnlyAfterTheChainHasBeenCheckedTests(ServerSendTestBase, APITestCase):
    """confirm_anchor is what reopens a record for sending, so it must be sure the
    earlier transaction can't mine beside a new one."""

    WALLET = "0x0d04d9835CbFc1E610C269DeB3F943670C72426b"

    def setUp(self):
        patcher = mock.patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", "0x" + "12" * 20)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _lost_anchor(self, *, hours_ago=2, actor=WALLET):
        from datetime import timedelta
        from django.utils import timezone
        return self._anchor(tx_hash="0x" + "ab" * 32, actor_address=actor,
                            anchored_at=timezone.now() - timedelta(hours=hours_ago))

    def _node(self, pending, latest):
        from .tests import sepolia_node
        w3 = sepolia_node(receipt_missing=True, tx_known=False)
        w3.eth.contract.return_value.functions.getAnchorsByRef.return_value.call.return_value = []
        w3.eth.get_transaction_count.side_effect = lambda _wallet, block: {"pending": pending, "latest": latest}[block]
        return w3

    def test_a_recent_uncertain_send_stays_pending(self):
        anchor = self._lost_anchor(hours_ago=0)
        self.assertEqual(blockchain.confirm_anchor(anchor, w3=self._node(16, 16)), blockchain.PENDING)
        anchor.refresh_from_db()
        self.assertTrue(anchor.anchored)

    def test_a_wallet_with_something_pending_keeps_it_closed(self):
        anchor = self._lost_anchor()
        self.assertEqual(blockchain.confirm_anchor(anchor, w3=self._node(17, 16)), blockchain.PENDING)
        anchor.refresh_from_db()
        self.assertTrue(anchor.anchored)
        self.assertFalse(AuditLog.objects.filter(action="blockchain.dropped").exists())

    def test_nothing_pending_clears_it_so_it_can_be_retried(self):
        anchor = self._lost_anchor()
        self.assertEqual(blockchain.confirm_anchor(anchor, w3=self._node(16, 16)), blockchain.DROPPED)
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, "")
        self.assertTrue(blockchain.anchor_summary(anchor)["can_reanchor"])

    def test_an_unreadable_nonce_is_never_read_as_nothing_pending(self):
        anchor = self._lost_anchor()
        w3 = self._node(16, 16)
        w3.eth.get_transaction_count.side_effect = ConnectionError("rpc down")
        self.assertEqual(blockchain.confirm_anchor(anchor, w3=w3), blockchain.UNKNOWN)
        anchor.refresh_from_db()
        self.assertTrue(anchor.anchored)

    def test_a_record_holding_it_on_chain_is_never_cleared(self):
        anchor = self._lost_anchor()
        w3 = self._node(16, 16)
        w3.eth.contract.return_value.functions.getAnchorsByRef.return_value.call.return_value = [
            (anchor.entity_type, anchor.entity_ref, anchor.stage, anchor.data_hash, self.WALLET, 1)]
        self.assertEqual(blockchain.confirm_anchor(anchor, w3=w3), blockchain.UNKNOWN)
        anchor.refresh_from_db()
        self.assertTrue(anchor.anchored)

    def test_older_rows_with_no_usable_sender_keep_the_earlier_rules(self):
        for actor in ("", "not-an-address"):
            with self.subTest(actor=actor):
                anchor = self._lost_anchor(actor=actor)
                w3 = self._node(99, 16)
                self.assertEqual(blockchain.confirm_anchor(anchor, w3=w3), blockchain.DROPPED)
                w3.eth.get_transaction_count.assert_not_called()


class AwardSendsCommitFirstTests(ServerSendTestBase, APITransactionTestCase):
    """Awarding writes three anchors in a row, after a long transaction of its own."""

    def test_every_award_anchor_commits_its_hash_before_sending(self):
        self._use_node()
        seen = []

        def record(_raw):
            seen.append((connection.in_atomic_block, BlockchainAnchor.objects.order_by("-id").first().tx_hash))

        self.node.on_send = record
        project = make_project(status=Project.Status.PUBLISHED)
        bid = qualified_bid(project, make_supplier(), 1000)
        self.client.force_authenticate(user=make_admin())
        res = self.client.post(f"/api/bids/{bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(len(seen), 3)
        for in_transaction, saved_hash in seen:
            self.assertFalse(in_transaction)
            self.assertTrue(saved_hash.startswith("0x"))


class SendIsNeverRepeatedByWeb3Tests(ServerSendTestBase, TestCase):
    """The real HTTP provider with only the socket replaced. By default web3 sends
    eth_sendRawTransaction up to 5 times after a timeout or an HTTP error, and the
    reply to a re-send can read like a refusal of the first attempt."""

    def _post(self, on_send):
        """Stands in for requests.Session.post; answers reads like a Sepolia node."""
        import requests
        from web3 import Web3

        self.posts = []

        def post(_session, _url, data=None, **_kwargs):
            call = json.loads(data)
            self.posts.append(call["method"])
            if call["method"] == "eth_sendRawTransaction":
                outcome = on_send(call["params"][0])
                if isinstance(outcome, Exception):
                    raise outcome
                body = outcome
            else:
                body = {"result": {
                    "eth_chainId": hex(11155111), "eth_getTransactionCount": hex(16),
                    "eth_estimateGas": hex(1_267_576), "eth_maxPriorityFeePerGas": hex(3),
                    "eth_gasPrice": hex(23),
                    "eth_getBlockByNumber": {"number": hex(12_070_000), "baseFeePerGas": hex(20)},
                }[call["method"]]}
            response = requests.Response()
            response.status_code = 200
            response._content = json.dumps({"jsonrpc": "2.0", "id": call["id"], **body}).encode()
            return response

        self.web3 = Web3
        return mock.patch("requests.Session.post", new=post)

    def _sign_with_real_provider(self):
        for name, value in {
            "SERVER_SIGNING_ENABLED": True,
            "BLOCKCHAIN_PRIVATE_KEY": "0x" + "22" * 32,
            "LEDGER_CONTRACT_ADDRESS": "0x" + "12" * 20,
        }.items():
            patcher = mock.patch(f"procurement.blockchain.{name}", value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_any_lost_reply_is_one_attempt_and_stays_uncertain(self):
        import requests

        self._sign_with_real_provider()
        for error in (requests.exceptions.ReadTimeout("no reply"), requests.HTTPError("502"),
                      requests.ConnectionError("reset")):
            with self.subTest(error.__class__.__name__):
                anchor = self._anchor()
                with self._post(lambda _raw, failure=error: failure):
                    result = blockchain.submit_anchor_server_side(anchor)
                self.assertEqual(self.posts.count("eth_sendRawTransaction"), 1)
                self.assertEqual(result.send_state, blockchain.SEND_UNCERTAIN)
                anchor.refresh_from_db()
                self.assertTrue(anchor.tx_hash.startswith("0x"))

    def test_a_retried_send_can_not_be_mistaken_for_a_refusal(self):
        # The scenario web3's re-send made possible: first attempt lost its reply
        # but got through, the re-send is answered "insufficient funds".
        import requests

        replies = [requests.exceptions.ReadTimeout("no reply"),
                   {"error": {"code": -32000, "message": "insufficient funds"}}]
        self._sign_with_real_provider()
        anchor = self._anchor()
        with self._post(lambda _raw: replies.pop(0)):
            blockchain.submit_anchor_server_side(anchor)
        anchor.refresh_from_db()
        self.assertTrue(anchor.tx_hash.startswith("0x"))
        self.assertFalse(blockchain.anchor_summary(anchor)["can_reanchor"])

    def test_a_real_node_error_through_the_real_provider_reopens_the_record(self):
        self._sign_with_real_provider()
        anchor = self._anchor()
        with self._post(lambda _raw: {"error": {"code": -32000, "message": "insufficient funds"}}):
            self.assertIsNone(blockchain.submit_anchor_server_side(anchor))
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, "")

    def test_reads_still_get_a_second_try_but_fit_inside_the_worker_timeout(self):
        import requests

        w3 = blockchain.web3_client()
        with mock.patch("requests.Session.post", side_effect=requests.ConnectionError("reset")) as post:
            with self.assertRaises(requests.ConnectionError):
                w3.eth.get_transaction_count("0x" + "11" * 20)
        self.assertEqual(post.call_count, blockchain.RPC_READ_ATTEMPTS)
        self.assertLess(blockchain.RPC_TIMEOUT_SECONDS * blockchain.RPC_READ_ATTEMPTS, 30)


class DeadNodeDuringAnAwardTests(APITestCase):
    """Three anchors at 16 seconds each outlast the 30-second request limit. A
    killed request would leave the later anchors uncreated and unretryable."""

    def setUp(self):
        for name, value in {
            "SERVER_SIGNING_ENABLED": True,
            "BLOCKCHAIN_PRIVATE_KEY": "0x" + "22" * 32,
            "LEDGER_CONTRACT_ADDRESS": "0x" + "12" * 20,
            "_node_down_until": 0.0,
        }.items():
            patcher = mock.patch(f"procurement.blockchain.{name}", value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _award_with_a_dead_node(self):
        import requests

        project = make_project(status=Project.Status.PUBLISHED)
        bid = qualified_bid(project, make_supplier(), 1000)
        self.client.force_authenticate(user=make_admin())
        with mock.patch("requests.Session.post", side_effect=requests.exceptions.ReadTimeout("no reply")) as post:
            res = self.client.post(f"/api/bids/{bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        return project, post

    def test_only_the_first_anchor_waits_and_all_three_are_created_and_retryable(self):
        project, post = self._award_with_a_dead_node()
        self.assertEqual(post.call_count, blockchain.RPC_READ_ATTEMPTS)
        anchors = BlockchainAnchor.objects.filter(entity_ref=project.code)
        self.assertEqual(
            {a.stage for a in anchors},
            {"EVALUATION_COMPLETED", "BID_SUBMITTED", "AWARDED"})
        for anchor in anchors:
            self.assertEqual(anchor.tx_hash, "")
            self.assertTrue(blockchain.anchor_summary(anchor)["can_reanchor"])

    def test_without_the_pause_every_anchor_would_wait(self):
        with mock.patch("procurement.blockchain.NODE_DOWN_PAUSE_SECONDS", -1):
            _, post = self._award_with_a_dead_node()
        self.assertEqual(post.call_count, 3 * blockchain.RPC_READ_ATTEMPTS)

    def test_a_contract_rejection_is_not_a_dead_node(self):
        blockchain._pause_if_node_unreachable(ValueError("execution reverted"))
        self.assertEqual(blockchain._node_down_until, 0.0)

    def test_sending_resumes_once_the_pause_is_over(self):
        self._award_with_a_dead_node()
        self.assertGreater(blockchain._node_down_until, 0)
        anchor = BlockchainAnchor.objects.first()
        with mock.patch("procurement.blockchain.web3_client") as client:
            client.side_effect = ValueError("reached the send path")
            self.assertIsNone(blockchain.submit_anchor_server_side(anchor))
            client.assert_not_called()
            with mock.patch("procurement.blockchain._node_down_until", 0.0):
                blockchain.submit_anchor_server_side(anchor)
            client.assert_called_once()


class StaleResultCanNotTouchANewerTransactionTests(ServerSendTestBase, APITestCase):
    """A chain check takes seconds. If the record was re-anchored meanwhile, what
    it found out is about the OLD hash. Clearing or flagging the new one would
    reopen a record whose transaction is on the network: the next send would be a
    permanent duplicate."""

    OLD = "0x" + "aa" * 32
    NEW = "0x" + "bb" * 32

    def setUp(self):
        patcher = mock.patch("procurement.blockchain.LEDGER_CONTRACT_ADDRESS", "0x" + "12" * 20)
        patcher.start()
        self.addCleanup(patcher.stop)
        anchor = self._anchor(tx_hash=self.OLD, actor_address="0x" + "33" * 20)
        self.stale = BlockchainAnchor.objects.get(pk=anchor.pk)
        BlockchainAnchor.objects.filter(pk=anchor.pk).update(tx_hash=self.NEW)
        self.pk = anchor.pk

    def _assert_new_hash_untouched(self):
        fresh = BlockchainAnchor.objects.get(pk=self.pk)
        self.assertEqual(fresh.tx_hash, self.NEW)
        self.assertEqual(fresh.chain_status, BlockchainAnchor.ChainStatus.UNCHECKED)
        self.assertFalse(blockchain.anchor_summary(fresh)["can_reanchor"])

    def test_a_revert_found_for_the_old_hash_does_not_clear_the_new_one(self):
        from .tests import sepolia_node
        outcome = blockchain.confirm_anchor(self.stale, w3=sepolia_node({"status": 0, "blockNumber": 1}))
        self.assertEqual(outcome, blockchain.UNKNOWN)
        self._assert_new_hash_untouched()
        self.assertFalse(AuditLog.objects.filter(action="blockchain.reverted").exists())

    def test_a_mismatch_found_for_the_old_hash_does_not_flag_the_new_one(self):
        from .tests import sepolia_node
        with mock.patch("procurement.blockchain.anchor_events", return_value=[]):
            blockchain.confirm_anchor(self.stale, w3=sepolia_node({"status": 1, "blockNumber": 1}))
        self._assert_new_hash_untouched()
        self.assertFalse(AuditLog.objects.filter(action="blockchain.mismatch").exists())

    def test_a_confirmation_of_the_old_hash_is_not_saved_on_the_new_one(self):
        from .tests import sepolia_node
        event = {"id": 5, "logIndex": 0, "timestamp": 1_800_000_000, "actor": "0x" + "33" * 20}
        with mock.patch("procurement.blockchain._matching_event", return_value=(event, "")), \
                mock.patch("procurement.blockchain._state_agrees", return_value=True):
            outcome = blockchain.confirm_anchor(self.stale, w3=sepolia_node({"status": 1, "blockNumber": 1}))
        self.assertEqual(outcome, blockchain.UNKNOWN)
        self._assert_new_hash_untouched()

    def test_a_browser_report_can_not_replace_a_hash_saved_after_it_was_read(self):
        result = blockchain.attach_transaction(self._empty_read(), "0x" + "cc" * 32)
        self.assertEqual(result.send_state, blockchain.SEND_CLAIMED_ELSEWHERE)
        self.assertEqual(result.tx_hash, self.NEW)

    def _empty_read(self):
        return BlockchainAnchor(pk=self.pk, tx_hash="", entity_type=self.stale.entity_type)

    def test_a_browser_report_that_lost_the_race_is_not_logged_as_anchored(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        anchor = self._anchor(entity_id=str(project.pk), entity_ref=project.code)
        real = blockchain.attach_transaction

        def server_saves_first(row, *args, **kwargs):
            BlockchainAnchor.objects.filter(pk=row.pk).update(tx_hash=self.NEW)
            return real(row, *args, **kwargs)

        self.client.force_authenticate(user=make_head())
        with mock.patch("procurement.views.attach_transaction", side_effect=server_saves_first):
            res = self.client.post(f"/api/projects/{project.pk}/anchor/",
                                   {"anchor_id": anchor.pk, "tx_hash": "0x" + "cc" * 32}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["tx_hash"], self.NEW)
        self.assertFalse(AuditLog.objects.filter(action="blockchain.anchored").exists())


class RefusedSendWithTheDatabaseDownTests(ServerSendTestBase, TestCase):
    def test_it_does_not_raise_into_the_request(self):
        # AGENTS.md rule 3. Staying closed is the safe side: nothing is re-sent.
        from django.db import OperationalError
        from django.db.models.query import QuerySet

        self._use_node(on_send=node_says("insufficient funds"))
        anchor = self._anchor(tx_hash="0x" + "ab" * 32)
        with mock.patch.object(QuerySet, "update", side_effect=OperationalError("gone")):
            result = blockchain._broadcast(anchor, anchor.tx_hash, b"\x01", self.w3, {"tx_hash": ""})
        self.assertIsNone(result)


class SecretsStayOutOfTheLogsTests(TestCase):
    """A hosted RPC URL carries its API key, and a transport error prints it."""

    KEY = "abcdef0123456789secretkey"
    SIGNING_KEY = "0x" + "22" * 32

    def _logged(self, url):
        import requests

        with mock.patch("procurement.blockchain.SEPOLIA_RPC_URL", url), \
                mock.patch("procurement.blockchain.BLOCKCHAIN_PRIVATE_KEY", self.SIGNING_KEY), \
                self.assertLogs("procurement.blockchain", level="WARNING") as logs:
            try:
                raise requests.ConnectionError(
                    f"HTTPSConnectionPool(host='rpc.example'): Max retries exceeded with url: "
                    f"{url.split('rpc.example')[1]} key {self.SIGNING_KEY}")
            except requests.ConnectionError:
                blockchain.logger.warning("Could not read %s", url, exc_info=True)
        return "\n".join(logs.output)

    def test_a_key_in_the_path_is_hidden_and_the_traceback_kept(self):
        output = self._logged(f"https://rpc.example/v3/{self.KEY}")
        self.assertNotIn(self.KEY, output)
        self.assertNotIn(self.SIGNING_KEY, output)
        self.assertNotIn("22" * 32, output)
        self.assertIn("ConnectionError", output)
        self.assertIn("Traceback", output)

    def test_a_key_in_the_query_is_hidden(self):
        self.assertNotIn(self.KEY, self._logged(f"https://rpc.example/rpc?apikey={self.KEY}"))

    def test_a_url_with_no_secret_part_stays_readable(self):
        with mock.patch("procurement.blockchain.SEPOLIA_RPC_URL", "https://rpc.example"), \
                mock.patch("procurement.blockchain.BLOCKCHAIN_PRIVATE_KEY", ""), \
                self.assertLogs("procurement.blockchain", level="WARNING") as logs:
            blockchain.logger.warning("Asked %s", "https://rpc.example")
        self.assertIn("https://rpc.example", logs.output[0])

    def test_the_real_transport_error_text_is_hidden_end_to_end(self):
        import requests

        with mock.patch("procurement.blockchain.SEPOLIA_RPC_URL", f"https://rpc.example/v3/{self.KEY}"), \
                mock.patch("requests.Session.post", side_effect=requests.ConnectionError(
                    f"Max retries exceeded with url: /v3/{self.KEY}")), \
                self.assertLogs("procurement.blockchain", level="WARNING") as logs:
            self.assertEqual(blockchain.network_check(blockchain.web3_client()), (None, None))
        self.assertNotIn(self.KEY, "\n".join(logs.output))


@skipUnless(connection.vendor == "postgresql", "needs real row concurrency: run against a local PostgreSQL")
class ConcurrentSendsOnPostgresTests(ServerSendTestBase, APITransactionTestCase):
    """Real threads and real connections. SQLite serialises every write, so it can
    only show the logic, never the race."""

    THREADS = 12

    def setUp(self):
        self._use_node()

    def _together(self, work):
        import threading

        barrier = threading.Barrier(self.THREADS)
        results = []

        def run():
            try:
                barrier.wait()
                results.append(work())
            finally:
                connection.close()

        threads = [threading.Thread(target=run) for _ in range(self.THREADS)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return results

    def test_one_anchor_is_sent_once_however_many_requests_arrive(self):
        anchor = self._anchor()
        copies = iter([BlockchainAnchor.objects.get(pk=anchor.pk) for _ in range(self.THREADS)])
        results = self._together(lambda: blockchain.submit_anchor_server_side(next(copies)))
        self.assertEqual(len(self.node.sent), 1)
        states = sorted(r.send_state for r in results)
        self.assertEqual(states.count(blockchain.SEND_SENT), 1)
        self.assertEqual(states.count(blockchain.SEND_CLAIMED_ELSEWHERE), self.THREADS - 1)
        anchor.refresh_from_db()
        self.assertEqual({r.tx_hash for r in results}, {anchor.tx_hash})

    def test_the_anchor_now_endpoint_sends_once_under_concurrent_clicks(self):
        from rest_framework.test import APIClient

        project = make_project(status=Project.Status.PENDING_HEAD)
        anchor = self._anchor(entity_id=str(project.pk), entity_ref=project.code)
        head = make_head()

        def click():
            client = APIClient()
            client.force_authenticate(user=head)
            return client.post(f"/api/projects/{project.pk}/anchor/",
                               {"anchor_id": anchor.pk, "server_submit": True}, format="json").status_code

        self.assertEqual(self._together(click), [status.HTTP_200_OK] * self.THREADS)
        self.assertEqual(len(self.node.sent), 1)
        self.assertEqual(AuditLog.objects.filter(action="blockchain.anchored").count(), 1)

    def test_a_refused_send_and_concurrent_retries_never_leave_two_on_the_network(self):
        # Every send refused: each may be followed by another, but the record ends
        # open and nothing was accepted, so this only checks nothing is lost or stuck.
        self.node.on_send = node_says("insufficient funds")
        anchor = self._anchor()
        copies = iter([BlockchainAnchor.objects.get(pk=anchor.pk) for _ in range(self.THREADS)])
        self._together(lambda: blockchain.submit_anchor_server_side(next(copies)))
        anchor.refresh_from_db()
        self.assertEqual(anchor.tx_hash, "")
