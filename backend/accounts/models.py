from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models


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

    def __str__(self):
        return f"{self.username} ({self.role})"


class AuditLog(models.Model):
    """An immutable record of a significant action taken in the system — login,
    project approval/publish, supplier verification, bid submission, award, etc.

    Implements the documented Audit_Logs table (Table 2.7): who did what, to
    which entity, and from where. Written only through accounts.audit.log_action,
    which never raises — recording an action must never be able to break the
    action itself. Rows are never edited or deleted in normal operation, so the
    log stays a trustworthy accountability trail.

    NOTE: the data dictionary types Entity_ID as UUID, but the app's records use
    integer primary keys, so entity_id is stored as text (the PK rendered as a
    string) to work regardless of the referenced table's key type."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,  # keep the log even if the account is later removed
        null=True,
        blank=True,
        related_name="audit_logs",
    )
    action = models.CharField(max_length=100)  # machine key, e.g. "project.published"
    entity_type = models.CharField(max_length=50, blank=True)  # e.g. "Project", "Bid"
    entity_id = models.CharField(max_length=64, blank=True)  # affected record's PK
    description = models.CharField(max_length=300, blank=True)  # human-readable summary
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["-created_at"]),
            models.Index(fields=["entity_type", "entity_id"]),
        ]

    def __str__(self):
        who = self.user.username if self.user else "system"
        return f"{who} · {self.action} · {self.created_at:%Y-%m-%d %H:%M}"
