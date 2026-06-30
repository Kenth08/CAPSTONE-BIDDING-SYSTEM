from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework import status
from rest_framework.test import APITestCase

from procurement.models import Supplier

from .emails import email_verification_token

User = get_user_model()


def dummy_pdf(name="doc.pdf"):
    return SimpleUploadedFile(name, b"%PDF-1.4 fake", content_type="application/pdf")


# All required documents for SupplierRegisterSerializer (see REQUIRED_DOCUMENTS
# in serializers.py) — every self/admin-assisted registration test reuses this.
REQUIRED_DOCS = [
    "sec_dti_certificate", "mayors_permit", "philgeps_certificate", "valid_id",
    "tax_clearance_certificate", "audited_financial_statements",
    "bank_reference_letter", "authorization_letter",
]


def registration_payload(email="new.supplier@example.com"):
    data = {
        "full_name": "Jane Dela Cruz",
        "email": email,
        "password": "Sup3rSecret!9",
        "confirm_password": "Sup3rSecret!9",
        "company_name": "Acme Trading Corp.",
        "company_address": "123 Rizal St, Manila",
        "phone_number": "09171234567",
        "tin": "123-456-789",
        "representative_name": "Jane Dela Cruz",
        "business_types": '["IT Equipment"]',
        "declaration_accepted": "true",
    }
    files = {key: dummy_pdf(f"{key}.pdf") for key in REQUIRED_DOCS}
    return {**data, **files}


class SupplierRegistrationTests(APITestCase):
    def setUp(self):
        # Throttle counters live in the cache, not the DB, so they survive the
        # per-test transaction rollback — clear them so one test's requests
        # never count against another's rate limit.
        cache.clear()

    def test_self_registration_creates_pending_supplier_and_sends_verification_email(self):
        res = self.client.post(
            "/api/auth/register/supplier/", registration_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)

        supplier = Supplier.objects.get(user__email="new.supplier@example.com")
        self.assertEqual(supplier.qualification_status, Supplier.Qualification.PENDING)
        self.assertFalse(supplier.email_verified)

        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Verify your", mail.outbox[0].subject)

    def test_registration_rejects_duplicate_email(self):
        self.client.post("/api/auth/register/supplier/", registration_payload(), format="multipart")
        res = self.client.post("/api/auth/register/supplier/", registration_payload(), format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_registration_rejects_password_mismatch(self):
        payload = registration_payload()
        payload["confirm_password"] = "something-else"
        res = self.client.post("/api/auth/register/supplier/", payload, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_admin_assisted_registration_requires_admin_role(self):
        res = self.client.post(
            "/api/auth/admin/register-supplier/", registration_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_401_UNAUTHORIZED)

        supplier_user = User.objects.create_user(username="sup1", password="pw", role=User.Role.SUPPLIER)
        self.client.force_authenticate(user=supplier_user)
        res = self.client.post(
            "/api/auth/admin/register-supplier/", registration_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_assisted_registration_succeeds_for_admin(self):
        admin = User.objects.create_user(username="admin1", password="pw", role=User.Role.ADMIN)
        self.client.force_authenticate(user=admin)
        res = self.client.post(
            "/api/auth/admin/register-supplier/",
            registration_payload(email="walkin.supplier@example.com"),
            format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        supplier = Supplier.objects.get(user__email="walkin.supplier@example.com")
        self.assertEqual(supplier.qualification_status, Supplier.Qualification.PENDING)


class EmailVerificationTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="verify@example.com", email="verify@example.com",
            password="pw", role=User.Role.SUPPLIER,
        )
        self.supplier = Supplier.objects.create(user=self.user, company="Verify Co", contact="Verify")

    def _link_params(self, user=None):
        user = user or self.user
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = email_verification_token.make_token(user)
        return uid, token

    def test_confirm_marks_supplier_email_verified(self):
        uid, token = self._link_params()
        res = self.client.post(
            "/api/auth/verify-email/confirm/", {"uid": uid, "token": token}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.supplier.refresh_from_db()
        self.assertTrue(self.supplier.email_verified)

    def test_confirm_rejects_bad_token(self):
        uid, _ = self._link_params()
        res = self.client.post(
            "/api/auth/verify-email/confirm/", {"uid": uid, "token": "not-a-real-token"}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.supplier.refresh_from_db()
        self.assertFalse(self.supplier.email_verified)

    def test_resend_requires_authentication(self):
        res = self.client.post("/api/auth/verify-email/resend/", {}, format="json")
        self.assertEqual(res.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_resend_sends_an_email_to_the_caller(self):
        self.client.force_authenticate(user=self.user)
        res = self.client.post("/api/auth/verify-email/resend/", {}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.user.email])


class LoginTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username="loginme", email="loginme@example.com", password="correct-pw",
            role=User.Role.SUPPLIER,
        )

    def test_login_with_username(self):
        res = self.client.post(
            "/api/auth/login/", {"username": "loginme", "password": "correct-pw"}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIn("access", res.data)
        self.assertEqual(res.data["user"]["role"], "supplier")

    def test_login_with_email(self):
        res = self.client.post(
            "/api/auth/login/", {"username": "loginme@example.com", "password": "correct-pw"}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

    def test_login_rejects_wrong_password(self):
        res = self.client.post(
            "/api/auth/login/", {"username": "loginme", "password": "wrong"}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_login_rejects_unknown_account(self):
        res = self.client.post(
            "/api/auth/login/", {"username": "nobody", "password": "x"}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
