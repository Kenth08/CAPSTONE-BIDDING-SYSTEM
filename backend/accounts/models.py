from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Custom user with a procurement role.

    The role decides which dashboard opens and which endpoints answer. Values are
    append-only: they are stored on every account and in every issued token.
    STAFF and BAC belong to the separation-of-duties workflow
    (settings.BAC_WORKFLOW_ENABLED); a BAC account's position (Chairperson,
    Vice-Chairperson, Member) is its procurement.BACMembership, not its role.
    """

    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        HEAD = "head", "Head"
        SUPPLIER = "supplier", "Supplier"
        STAFF = "staff", "Procurement Staff"
        BAC = "bac", "BAC Committee"

    role = models.CharField(max_length=20, choices=Role.choices, default=Role.SUPPLIER)
    # The display name, composed from first_name, middle_name and last_name
    # (AbstractUser already has first_name and last_name). Accounts created
    # before the split keep the name as typed with empty parts (accounts/names.py).
    full_name = models.CharField(max_length=150, blank=True)
    middle_name = models.CharField(max_length=150, blank=True, default="", db_default="")
    # Set whenever the password is changed (self-service change or reset
    # confirm) so a failed login can tell the user how recently it happened.
    password_changed_at = models.DateTimeField(null=True, blank=True)
    # Temporary lockout after repeated wrong passwords (accounts/lockout.py).
    # db_default so the previous release can keep creating users mid-deploy.
    failed_login_count = models.PositiveIntegerField(default=0, db_default=0)
    locked_until = models.DateTimeField(null=True, blank=True)
    # Two-factor authentication (accounts/mfa.py). The secret is encrypted at
    # rest when FILE_ENCRYPTION_KEY is set; mfa_last_step stops code replay.
    mfa_enabled = models.BooleanField(default=False, db_default=False)
    mfa_secret = models.TextField(blank=True, default="", db_default="")
    mfa_last_step = models.BigIntegerField(null=True, blank=True)

    def __str__(self):
        return f"{self.username} ({self.role})"


class MFABackupCode(models.Model):
    """One single-use recovery code for when the authenticator app is lost.
    Only a salted SHA-256 of the code is stored (accounts/mfa.py)."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="mfa_backup_codes")
    salt = models.CharField(max_length=32)
    code_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    used_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"{self.user} backup code ({'used' if self.used_at else 'unused'})"


class AuditLogImmutable(Exception):
    """Raised on any attempt to edit or delete an audit entry through the ORM."""


class AuditLogQuerySet(models.QuerySet):
    """Bulk edits and deletes are refused: the log is append-only.

    (Deleting a user still works: Django's on_delete=SET_NULL clears the user
    column with a low-level update that does not go through this queryset, and
    the database trigger in migration 0008 allows exactly that one change.)"""

    def update(self, **kwargs):
        raise AuditLogImmutable("Audit log entries cannot be edited.")

    def delete(self):
        raise AuditLogImmutable("Audit log entries cannot be deleted.")


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

    objects = AuditLogQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["-created_at"]),
            models.Index(fields=["entity_type", "entity_id"]),
        ]

    def save(self, *args, **kwargs):
        # Append-only: an existing entry can never be rewritten. Enforced again
        # in PostgreSQL by a trigger (migration 0008) for anything below the ORM.
        if self.pk is not None and not self._state.adding:
            raise AuditLogImmutable("Audit log entries cannot be edited.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AuditLogImmutable("Audit log entries cannot be deleted.")

    def __str__(self):
        who = self.user.username if self.user else "system"
        return f"{who} · {self.action} · {self.created_at:%Y-%m-%d %H:%M}"


class RequestOutcome(models.Model):
    """How one write request from the browser ended, so the browser can find out
    when it never received the answer.

    The live host cuts any request that takes longer than 30 seconds and sends
    the browser an error, but the server keeps working and usually finishes.
    The browser then said "Cannot reach the server" about a procurement, bid
    or registration that had in fact been saved, people tried again, and
    duplicates followed. Now the browser sends a random Idempotency-Key with a
    write, accounts/idempotency.py records here how it ended, and after a cut
    connection the browser asks GET /api/auth/requests/<key>/ instead of
    guessing.

    Rows are only for that question and are pruned after
    RequestOutcome.RETENTION. Requests whose answer is a credential (sign-in,
    token refresh, download links) are never recorded."""

    class State(models.TextChoices):
        PENDING = "pending", "Pending"
        DONE = "done", "Done"

    key = models.CharField(max_length=64, unique=True)
    method = models.CharField(max_length=8)
    path = models.CharField(max_length=300)
    # Who made the request, once authentication has run. Only that user may
    # read the outcome; a row with no user (a registration) needs only the key.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE,
        related_name="+")
    state = models.CharField(max_length=10, choices=State.choices, default=State.PENDING)
    status_code = models.PositiveSmallIntegerField(null=True, blank=True)
    # The JSON response body, as sent. Empty when it wasn't JSON or was too big.
    body = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "request_outcomes"

    def __str__(self):
        return f"{self.method} {self.path} [{self.state}]"
