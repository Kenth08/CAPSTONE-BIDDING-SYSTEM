"""Regression tests for the bugs found in the 2026-08 codebase audit.

Each class below pins ONE defect that was confirmed by execution before it was
fixed. The docstrings record what actually went wrong, so a future change that
reintroduces the behaviour fails here with an explanation rather than just a red
assertion.
"""
from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework import status
from rest_framework.test import APITestCase

from accounts.serializers import RoleTokenObtainPairSerializer

from .models import Award, Bid, BidAttachment, Project, Supplier
from .tests import dummy_pdf, make_admin, make_head, make_project, make_supplier

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

    def test_code_continues_from_the_highest_existing_number(self):
        self._create()
        self._create()
        Project.objects.filter(code__endswith="-001").delete()
        res = self._create()
        # 002 exists, so the next is 003 — never a re-used 002.
        self.assertEqual(res.data["code"][-3:], "003")


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

    def test_a_draft_can_still_be_edited_and_deleted(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        edit = self.client.patch(
            f"/api/projects/{project.pk}/", {"description": "clarified"}, format="json")
        self.assertEqual(edit.status_code, status.HTTP_200_OK)
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


class RegisterPasswordStrengthTests(APITestCase):
    """/auth/register/ accepted any six-character password with no strength
    check — a public back door around the policy the real form enforces."""

    def setUp(self):
        cache.clear()

    def test_a_weak_password_is_rejected(self):
        res = self.client.post("/api/auth/register/", {
            "username": "weakling", "email": "weak@example.com", "password": "123456",
        }, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("password", res.data)

    def test_a_strong_password_is_accepted_and_role_stays_supplier(self):
        res = self.client.post("/api/auth/register/", {
            "username": "strongling", "email": "strong@example.com",
            "password": "Str0ng!Passphrase1", "role": "admin",
        }, format="json")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(User.objects.get(username="strongling").role, User.Role.SUPPLIER)


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
