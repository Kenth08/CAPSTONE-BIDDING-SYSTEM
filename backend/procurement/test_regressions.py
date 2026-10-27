"""Regression tests for the bugs found in the 2026-08 codebase audit.

Each class below pins ONE defect that was confirmed by execution before it was
fixed. The docstrings record what actually went wrong, so a future change that
reintroduces the behaviour fails here with an explanation rather than just a red
assertion.
"""
import contextlib
import io
import re
from urllib.parse import parse_qs, urlparse
from unittest import mock

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
from rest_framework.test import APITestCase

from accounts.emails import email_verification_token
from accounts.models import AuditLog
from accounts.serializers import RoleTokenObtainPairSerializer
from accounts.tests import registration_payload

from .management.commands import seed as seed_cmd
from .models import Award, Bid, BidAttachment, BlockchainAnchor, Project, Supplier, SupplierCategoryDocument
from .tests import IN_A_YEAR, IN_TWO_YEARS, attach_base_documents, dummy_pdf, make_admin, make_head, make_project, make_supplier

User = get_user_model()


def qualified_bid(project, supplier, amount=1000):
    return Bid.objects.create(
        project=project, supplier=supplier, amount=amount, status=Bid.Status.QUALIFIED,
    )


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
        import re
        codes = [self._create().data["code"] for _ in range(5)]
        pattern = re.compile(r"^PRC-\d{4}-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}$")
        for code in codes:
            self.assertRegex(code, pattern)
            self.assertLessEqual(len(code), Project._meta.get_field("code").max_length)
        self.assertEqual(len(set(codes)), 5)

    def test_create_retries_when_a_random_code_is_already_taken(self):
        from unittest import mock
        existing = self._create().data["code"]
        with mock.patch(
            "procurement.views.next_project_code",
            side_effect=[existing, "PRC-2026-ABCD-EFGH"],
        ):
            res = self._create()
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(res.data["code"], "PRC-2026-ABCD-EFGH")


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

    def test_signed_link_works_without_an_auth_header(self):
        # This is the case a plain <a href target="_blank"> hits: a browser
        # navigation carries no Authorization header.
        url = self._url_for_owner()
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

        url = self._url_for_owner()
        token = url.split("t=")[1]
        self.client.force_authenticate(user=None)
        # Same signature, different supplier in the path — the token is bound to
        # one kind/pk/field, so it must not unlock the rival's document.
        res = self.client.get(f"/api/files/supplier/{self.rival.pk}/valid_id/?t={token}")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_a_tampered_token_is_rejected(self):
        url = self._url_for_owner()
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
        self.client.post(
            f"/api/awards/{self.award.pk}/documents/generate/",
            {"key": "notice_of_award"}, format="json")
        self.client.force_authenticate(user=self.loser.user)
        res = self.client.get(f"/api/files/award/{self.award.pk}/notice_of_award/")
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)


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
        self.furniture.purchase_request = dummy_pdf()
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
        doc = self.client.get(f"/api/files/project/{self.furniture.pk}/purchase_request/")
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
                "'waiting_admin_approval', 0, '2026-10-20', '', '', '', '', '[]', NULL, NULL, NULL, '', 0, "
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
        self.assertEqual(res.status_code, status.HTTP_200_OK)


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

    def test_serializer_emits_a_signed_supplierdoc_url(self):
        self.client.force_authenticate(user=self.owner.user)
        res = self.client.get("/api/suppliers/me/")
        doc = next(d for d in res.data["documents"] if d["key"] == "fda_lto")
        self.assertIn("/api/files/supplierdoc/", doc["url"])
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(doc["url"]).status_code, status.HTTP_200_OK)

    def test_owner_can_read(self):
        self.client.force_authenticate(user=self.owner.user)
        self.assertEqual(self.client.get(self.path).status_code, status.HTTP_200_OK)

    def test_rival_supplier_cannot_read(self):
        self.client.force_authenticate(user=self.rival.user)
        self.assertEqual(self.client.get(self.path).status_code, status.HTTP_404_NOT_FOUND)

    def test_admin_and_head_can_read(self):
        for user in (make_admin(), make_head()):
            with self.subTest(role=user.role):
                self.client.force_authenticate(user=user)
                self.assertEqual(self.client.get(self.path).status_code, status.HTTP_200_OK)

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
