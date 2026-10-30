"""Sign-in protection: lockout, proxy-aware rate limits, token rotation, and
the Django admin login. See accounts/lockout.py and SECURITY.md."""
import io
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.test import RequestFactory, TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .audit import get_client_ip
from .lockout import LOCKED_MESSAGE, LOCKOUT_THRESHOLD
from .models import AuditLog, AuditLogImmutable

User = get_user_model()
LOGIN = "/api/auth/login/"


def detail(res):
    """DRF wraps serializer errors in a list; the UI joins them."""
    value = res.data["detail"]
    return str(value[0] if isinstance(value, list) else value)


def make_user(username="alice", password="Correct-Horse-9", role="supplier", **extra):
    return User.objects.create_user(username=username, email=f"{username}@example.com",
                                    password=password, role=role, **extra)


class _LoginCase(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = make_user()

    def login(self, password, username="alice", ip="198.51.100.7", **headers):
        # A fresh IP per call by default would hide the lockout behind the
        # per-IP throttle; these tests are about the per-ACCOUNT lock.
        return self.client.post(LOGIN, {"username": username, "password": password},
                                format="json", REMOTE_ADDR=ip, **headers)

    def fail(self, n, username="alice"):
        # A different source IP per attempt, as a botnet would use: the per-IP
        # throttle never triggers, so only the per-account lock can stop it.
        for i in range(n):
            self.login("wrong", username=username, ip=f"192.0.2.{i + 1}")


class AccountLockoutTests(_LoginCase):
    def test_five_failures_lock_the_account_even_for_the_right_password(self):
        self.fail(LOCKOUT_THRESHOLD)
        cache.clear()
        res = self.login("Correct-Horse-9")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(detail(res), LOCKED_MESSAGE)
        self.user.refresh_from_db()
        self.assertGreater(self.user.locked_until, timezone.now() + timedelta(minutes=14))

    def test_lock_is_temporary(self):
        self.fail(LOCKOUT_THRESHOLD)
        User.objects.filter(pk=self.user.pk).update(locked_until=timezone.now() - timedelta(seconds=1))
        cache.clear()
        self.assertEqual(self.login("Correct-Horse-9").status_code, status.HTTP_200_OK)
        self.user.refresh_from_db()
        self.assertEqual((self.user.failed_login_count, self.user.locked_until), (0, None))

    def test_success_resets_the_count(self):
        self.fail(LOCKOUT_THRESHOLD - 1)
        cache.clear()
        self.assertEqual(self.login("Correct-Horse-9").status_code, status.HTTP_200_OK)
        self.fail(LOCKOUT_THRESHOLD - 1)
        cache.clear()
        self.assertEqual(self.login("Correct-Horse-9").status_code, status.HTTP_200_OK)

    def test_failures_and_the_lock_are_audit_logged(self):
        self.fail(LOCKOUT_THRESHOLD)
        self.assertEqual(AuditLog.objects.filter(action="auth.login_failed", user=self.user).count(),
                         LOCKOUT_THRESHOLD)
        self.assertTrue(AuditLog.objects.filter(action="auth.account_locked", user=self.user).exists())

    def test_unknown_accounts_get_the_same_lock_answer(self):
        """The lock message must not reveal whether an account exists."""
        self.fail(LOCKOUT_THRESHOLD, username="ghost")
        unknown_state = self.login("whatever", username="ghost")
        self.fail(LOCKOUT_THRESHOLD)
        real_state = self.login("whatever")
        self.assertEqual(detail(unknown_state), LOCKED_MESSAGE)
        self.assertEqual(detail(real_state), LOCKED_MESSAGE)

    def test_wrong_password_message_stays_generic(self):
        known = detail(self.login("wrong"))
        unknown = detail(self.login("wrong", username="ghost", ip="192.0.2.200"))
        self.assertEqual(known, unknown)


class AdminUnlockTests(_LoginCase):
    def setUp(self):
        super().setUp()
        self.admin = make_user("boss", role="admin")
        self.fail(LOCKOUT_THRESHOLD)

    def test_admin_can_unlock(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/auth/users/{self.user.pk}/unlock/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.client.force_authenticate(user=None)
        cache.clear()
        self.assertEqual(self.login("Correct-Horse-9").status_code, status.HTTP_200_OK)
        self.assertTrue(AuditLog.objects.filter(action="auth.account_unlocked", user=self.admin).exists())

    def test_only_admins_can_unlock(self):
        for role in ("supplier", "head"):
            self.client.force_authenticate(user=make_user(f"x{role}", role=role))
            res = self.client.post(f"/api/auth/users/{self.user.pk}/unlock/")
            self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_sees_the_lock_on_the_supplier_profile(self):
        from procurement.models import Supplier
        supplier = Supplier.objects.create(user=self.user, company="Alice Trading")
        self.client.force_authenticate(user=self.admin)
        data = self.client.get(f"/api/suppliers/{supplier.pk}/").data
        self.assertEqual(data["user_id"], self.user.pk)
        self.assertIsNotNone(data["account_locked_until"])
        self.client.post(f"/api/auth/users/{self.user.pk}/unlock/")
        self.assertIsNone(self.client.get(f"/api/suppliers/{supplier.pk}/").data["account_locked_until"])

    def test_management_command_unlocks(self):
        call_command("unlock_account", "alice@example.com", stdout=io.StringIO())
        self.user.refresh_from_db()
        self.assertIsNone(self.user.locked_until)


class ForwardedForBypassTests(_LoginCase):
    """Rotating a fake X-Forwarded-For used to reset the per-IP login limit."""

    def _rotating(self, n):
        return [self.login(f"wrong{i}", username="ghost", ip="203.0.113.50",
                           HTTP_X_FORWARDED_FOR=f"10.{i}.0.1").status_code for i in range(n)]

    def test_spoofed_header_is_ignored_without_a_proxy(self):
        self.assertIn(status.HTTP_429_TOO_MANY_REQUESTS, self._rotating(8))

    def test_behind_one_proxy_only_the_proxy_appended_hop_counts(self):
        with override_settings(REST_FRAMEWORK={
                **__import__("django.conf").conf.settings.REST_FRAMEWORK, "NUM_PROXIES": 1}):
            codes = [self.login(f"wrong{i}", username="ghost", ip="10.0.0.2",
                                HTTP_X_FORWARDED_FOR=f"1.2.3.{i}, 198.51.100.77").status_code
                     for i in range(8)]
        self.assertIn(status.HTTP_429_TOO_MANY_REQUESTS, codes)


class ClientIpTests(TestCase):
    def setUp(self):
        self.rf = RequestFactory()

    def test_without_a_proxy_the_socket_address_is_used(self):
        req = self.rf.get("/", REMOTE_ADDR="198.51.100.1", HTTP_X_FORWARDED_FOR="6.6.6.6")
        with override_settings(TRUSTED_PROXY_COUNT=0):
            self.assertEqual(get_client_ip(req), "198.51.100.1")

    def test_behind_one_proxy_the_rightmost_hop_is_used(self):
        req = self.rf.get("/", REMOTE_ADDR="10.0.0.2", HTTP_X_FORWARDED_FOR="6.6.6.6, 198.51.100.9")
        with override_settings(TRUSTED_PROXY_COUNT=1):
            self.assertEqual(get_client_ip(req), "198.51.100.9")

    def test_garbage_is_not_an_ip(self):
        req = self.rf.get("/", REMOTE_ADDR="10.0.0.2", HTTP_X_FORWARDED_FOR="<script>")
        with override_settings(TRUSTED_PROXY_COUNT=1):
            self.assertIsNone(get_client_ip(req))


class TokenRotationTests(_LoginCase):
    def test_access_tokens_are_short_lived(self):
        from rest_framework_simplejwt.settings import api_settings
        self.assertEqual(api_settings.ACCESS_TOKEN_LIFETIME, timedelta(minutes=15))

    def test_refresh_rotates_and_the_old_refresh_token_is_blacklisted(self):
        tokens = self.login("Correct-Horse-9").data
        first = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertIn("refresh", first.data)
        self.assertNotEqual(first.data["refresh"], tokens["refresh"])
        replay = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(replay.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logout_blacklists_the_refresh_token(self):
        tokens = self.login("Correct-Horse-9").data
        self.client.post("/api/auth/logout/", {"refresh": tokens["refresh"]}, format="json")
        res = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_401_UNAUTHORIZED)


@override_settings(STORAGES={
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class DjangoAdminLoginTests(TestCase):
    def setUp(self):
        cache.clear()
        self.staff = make_user("staffer", role="admin", is_staff=True, is_superuser=True)

    def _post(self, password):
        from django.conf import settings
        return self.client.post(f"/{settings.ADMIN_URL}login/",
                                {"username": "staffer", "password": password})

    def test_admin_login_locks_after_repeated_failures(self):
        for _ in range(LOCKOUT_THRESHOLD):
            self.assertEqual(self._post("wrong").status_code, 200)
        res = self._post("Correct-Horse-9")
        self.assertEqual(res.status_code, 200)          # form re-rendered, not redirected
        self.assertContains(res, "locked for 15 minutes")
        self.assertTrue(AuditLog.objects.filter(action="auth.account_locked", user=self.staff).exists())
        self.assertTrue(AuditLog.objects.filter(action="auth.login_failed",
                                                description__contains="admin").exists())


class AuditLogAppendOnlyTests(TestCase):
    def setUp(self):
        self.user = make_user("logged")
        self.entry = AuditLog.objects.create(user=self.user, action="test.action", description="x")

    def test_entries_cannot_be_edited_or_deleted_through_the_orm(self):
        self.entry.description = "rewritten"
        with self.assertRaises(AuditLogImmutable):
            self.entry.save()
        with self.assertRaises(AuditLogImmutable):
            self.entry.delete()
        with self.assertRaises(AuditLogImmutable):
            AuditLog.objects.filter(pk=self.entry.pk).update(description="rewritten")
        with self.assertRaises(AuditLogImmutable):
            AuditLog.objects.all().delete()
        self.assertEqual(AuditLog.objects.get(pk=self.entry.pk).description, "x")

    def test_deleting_a_user_keeps_their_entries(self):
        self.user.delete()
        self.entry = AuditLog.objects.get(pk=self.entry.pk)
        self.assertIsNone(self.entry.user)
        self.assertEqual(self.entry.action, "test.action")

    def test_database_trigger_blocks_raw_sql_on_postgresql(self):
        from django.db import DatabaseError, connection, transaction
        if connection.vendor != "postgresql":
            self.skipTest("The append-only trigger exists only on PostgreSQL.")
        for sql in ("UPDATE accounts_auditlog SET description = 'x2' WHERE id = %s",
                    "DELETE FROM accounts_auditlog WHERE id = %s"):
            with self.assertRaises(DatabaseError), transaction.atomic():
                with connection.cursor() as cur:
                    cur.execute(sql, [self.entry.pk])


class PermissionDeniedLoggingTests(APITestCase):
    def test_a_403_for_a_signed_in_user_is_audit_logged(self):
        supplier = make_user("sneaky", role="supplier")
        self.client.force_authenticate(user=supplier)
        res = self.client.get("/api/suppliers/")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)
        log = AuditLog.objects.get(action="auth.permission_denied")
        self.assertEqual(log.user, supplier)
        self.assertIn("GET /api/suppliers/", log.description)

    def test_anonymous_401s_are_not_logged(self):
        self.assertEqual(self.client.get("/api/suppliers/").status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertFalse(AuditLog.objects.filter(action="auth.permission_denied").exists())
