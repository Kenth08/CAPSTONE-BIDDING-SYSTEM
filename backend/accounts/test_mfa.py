"""Two-factor authentication (accounts/mfa.py)."""
import io
import time

import pyotp
from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from .lockout import LOCKED_MESSAGE, LOCKOUT_THRESHOLD
from .models import AuditLog, MFABackupCode

User = get_user_model()
PASSWORD = "Correct-Horse-9"


def detail(res):
    value = res.data["detail"]
    return str(value[0] if isinstance(value, list) else value)


@override_settings(MFA_REQUIRED=True)
class _MfaCase(APITestCase):
    def setUp(self):
        cache.clear()
        self.head = User.objects.create_user(username="head1", email="head1@example.com",
                                             password=PASSWORD, role="head")
        self.n = 0

    def login(self, username="head1", password=PASSWORD):
        self.n += 1   # a fresh IP each time keeps the per-IP throttle out of these tests
        return self.client.post("/api/auth/login/", {"username": username, "password": password},
                                format="json", REMOTE_ADDR=f"192.0.2.{self.n}")

    def setup(self, ticket):
        return self.client.post("/api/auth/mfa/setup/", {"mfa_token": ticket}, format="json")

    def verify(self, ticket, code):
        self.n += 1
        return self.client.post("/api/auth/mfa/verify/", {"mfa_token": ticket, "code": code},
                                format="json", REMOTE_ADDR=f"198.51.100.{self.n}")

    def enroll(self):
        ticket = self.login().data["mfa_token"]
        secret = self.setup(ticket).data["secret"]
        res = self.verify(ticket, pyotp.TOTP(secret).now())
        self.assertEqual(res.status_code, 200, res.data)
        return secret, res.data


class MfaLoginFlowTests(_MfaCase):
    def test_password_alone_gives_no_tokens_to_admin_or_head(self):
        res = self.login()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.data["mfa_required"])
        self.assertFalse(res.data["mfa_enrolled"])
        self.assertNotIn("access", res.data)
        self.assertNotIn("refresh", res.data)

    def test_suppliers_are_not_asked_for_a_code(self):
        User.objects.create_user(username="sup", password=PASSWORD, role="supplier")
        res = self.login("sup")
        self.assertIn("access", res.data)

    @override_settings(MFA_REQUIRED=False)
    def test_switched_off_with_mfa_required_false(self):
        self.assertIn("access", self.login().data)

    def test_enrollment_returns_qr_and_then_tokens_and_backup_codes(self):
        ticket = self.login().data["mfa_token"]
        setup = self.setup(ticket).data
        self.assertTrue(setup["qr"].startswith("data:image/svg+xml"))
        self.assertIn("otpauth://totp/", setup["otpauth_uri"])
        res = self.verify(ticket, pyotp.TOTP(setup["secret"]).now())
        self.assertIn("access", res.data)
        self.assertEqual(len(res.data["backup_codes"]), 10)
        self.head.refresh_from_db()
        self.assertTrue(self.head.mfa_enabled)
        self.assertTrue(AuditLog.objects.filter(action="auth.mfa_enrolled", user=self.head).exists())

    def test_enrolled_user_signs_in_with_a_code(self):
        secret, _ = self.enroll()
        ticket = self.login().data
        self.assertTrue(ticket["mfa_enrolled"])
        code = pyotp.TOTP(secret).at(time.time() + 30)    # next step: not yet used
        res = self.verify(ticket["mfa_token"], code)
        self.assertIn("access", res.data)
        self.assertNotIn("backup_codes", res.data)

    def test_a_code_cannot_be_replayed(self):
        secret, _ = self.enroll()
        code = pyotp.TOTP(secret).at(time.time() + 30)
        self.assertEqual(self.verify(self.login().data["mfa_token"], code).status_code, 200)
        self.assertEqual(self.verify(self.login().data["mfa_token"], code).status_code, 400)

    def test_backup_codes_work_once_and_are_stored_hashed(self):
        _, data = self.enroll()
        code = data["backup_codes"][0]
        self.assertFalse(MFABackupCode.objects.filter(code_hash__icontains=code.replace("-", "")).exists())
        self.assertEqual(self.verify(self.login().data["mfa_token"], code).status_code, 200)
        self.assertEqual(self.verify(self.login().data["mfa_token"], code).status_code, 400)
        self.assertTrue(AuditLog.objects.filter(action="auth.mfa_backup_code_used").exists())

    def test_setup_is_refused_once_enrolled(self):
        self.enroll()
        self.assertEqual(self.setup(self.login().data["mfa_token"]).status_code, 400)

    def test_forged_or_stale_tickets_are_refused(self):
        self.assertEqual(self.verify("not-a-ticket", "123456").status_code, 400)
        ticket = self.login().data["mfa_token"]
        self.head.set_password("Another-Pass-77")
        self.head.save()
        self.assertEqual(self.setup(ticket).status_code, 400)

    @override_settings(FILE_ENCRYPTION_KEY=Fernet.generate_key().decode())
    def test_secret_is_encrypted_at_rest(self):
        secret, _ = self.enroll()
        self.head.refresh_from_db()
        self.assertNotIn(secret, self.head.mfa_secret)
        self.assertTrue(self.head.mfa_secret.startswith("PCENC1"))


class MfaLockoutTests(_MfaCase):
    def test_wrong_codes_lock_the_account(self):
        secret, _ = self.enroll()
        ticket = self.login().data["mfa_token"]
        for _ in range(LOCKOUT_THRESHOLD):
            res = self.verify(ticket, "000000")
        self.assertEqual(detail(res), LOCKED_MESSAGE)
        res = self.verify(ticket, pyotp.TOTP(secret).at(time.time() + 30))
        self.assertEqual(detail(res), LOCKED_MESSAGE)

    def test_a_correct_password_does_not_reset_the_code_counter(self):
        self.enroll()
        for _ in range(LOCKOUT_THRESHOLD - 1):
            self.verify(self.login().data["mfa_token"], "000000")
        ticket = self.login().data["mfa_token"]          # password OK again
        self.assertEqual(detail(self.verify(ticket, "000000")), LOCKED_MESSAGE)


class ResetMfaTests(_MfaCase):
    def test_command_clears_mfa_and_backup_codes(self):
        self.enroll()
        call_command("reset_mfa", "head1", stdout=io.StringIO())
        self.head.refresh_from_db()
        self.assertFalse(self.head.mfa_enabled)
        self.assertEqual(self.head.mfa_secret, "")
        self.assertFalse(MFABackupCode.objects.filter(user=self.head).exists())
        self.assertTrue(AuditLog.objects.filter(action="auth.mfa_reset").exists())
        self.assertFalse(self.login().data["mfa_enrolled"])


@override_settings(MFA_REQUIRED=True, STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class DjangoAdminMfaTests(TestCase):
    def setUp(self):
        from django.conf import settings
        cache.clear()
        self.url = f"/{settings.ADMIN_URL}login/"
        self.staff = User.objects.create_user(username="staffer", password=PASSWORD, role="admin",
                                              is_staff=True, is_superuser=True)

    def _post(self, code=""):
        return self.client.post(self.url, {"username": "staffer", "password": PASSWORD, "otp_code": code})

    def test_not_enrolled_staff_cannot_enter(self):
        res = self._post()
        self.assertEqual(res.status_code, 200)
        self.assertContains(res, "Two-factor authentication is required")

    def test_enrolled_staff_needs_the_code(self):
        from . import mfa
        secret, _, _ = mfa.start_enrollment(self.staff)
        self.staff.refresh_from_db()
        self.staff.mfa_enabled = True
        self.staff.save()
        self.assertContains(self._post("000000"), "not valid")
        res = self._post(pyotp.TOTP(secret).now())
        self.assertEqual(res.status_code, 302)
        self.assertTrue(AuditLog.objects.filter(action="auth.admin_login", user=self.staff).exists())

    def test_login_page_shows_the_code_field(self):
        self.assertContains(self.client.get(self.url), 'name="otp_code"')
