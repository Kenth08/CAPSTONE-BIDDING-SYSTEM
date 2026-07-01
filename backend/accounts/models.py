import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


class User(AbstractUser):
    """Custom user with a procurement role.

    The frontend currently stores `localStorage.role` as one of
    admin / head / supplier. This replaces that with a real account.
    """

    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        HEAD = "head", "Head"
        SUPPLIER = "supplier", "Supplier"

    role = models.CharField(max_length=20, choices=Role.choices, default=Role.SUPPLIER)
    full_name = models.CharField(max_length=150, blank=True)
    # Set whenever the password is changed (self-service change or reset
    # confirm) so a failed login can tell the user how recently it happened.
    password_changed_at = models.DateTimeField(null=True, blank=True)
    mfa_enabled = models.BooleanField(default=False)

    def __str__(self):
        return f"{self.username} ({self.role})"


class MFACode(models.Model):
    """Short-lived one-time code for email-based two-factor auth.

    Only Admin and Head accounts use MFA.  A new code overwrites the
    previous one (update_or_create) so repeated "send code" clicks don't
    pile up rows.  The code is deleted after a successful verify.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="mfa_code",
    )
    code = models.CharField(max_length=6)
    expires_at = models.DateTimeField()

    @classmethod
    def generate_for(cls, user):
        code = f"{secrets.randbelow(1_000_000):06d}"
        cls.objects.update_or_create(
            user=user,
            defaults={"code": code, "expires_at": timezone.now() + timedelta(minutes=5)},
        )
        return code

    def is_valid(self, submitted):
        return self.code == submitted and timezone.now() <= self.expires_at
