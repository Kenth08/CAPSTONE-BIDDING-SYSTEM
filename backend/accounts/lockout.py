"""Temporary account lockout after repeated failed sign-ins.

The per-IP login throttle stops one machine from hammering the login route,
but not a botnet spreading guesses for one account across many addresses. So
each account also counts its own consecutive failures:

    LOCKOUT_THRESHOLD wrong passwords in a row → locked for LOCKOUT_DURATION.

While locked, even the right password is refused. The lock lifts by itself, a
successful sign-in resets the count, and an Admin can unlock early
(POST /api/auth/users/<id>/unlock/, the Django admin, or
`manage.py unlock_account <username>`).

Identifiers that match no account get the same treatment, counted in the cache:
after LOCKOUT_THRESHOLD attempts they receive the same "locked" answer, so the
lock message can't be used to discover which usernames or emails exist.

Every failure, lock and unlock is written to the audit log. The same rules
protect the Django admin login (accounts/admin_site.py).
"""
import hashlib
from datetime import timedelta

from django.core.cache import cache
from django.db.models import F
from django.utils import timezone

from .audit import log_action

LOCKOUT_THRESHOLD = 5
LOCKOUT_DURATION = timedelta(minutes=15)

LOCKED_MESSAGE = (
    "Too many failed sign-in attempts. This account is locked for 15 minutes — "
    "try again later or ask an administrator to unlock it."
)


def _unknown_key(identifier):
    digest = hashlib.sha256((identifier or "").strip().lower().encode("utf-8")).hexdigest()
    return f"login-unknown:{digest}"


def is_locked(user):
    return bool(user and user.locked_until and user.locked_until > timezone.now())


def unknown_identifier_locked(identifier):
    return cache.get(_unknown_key(identifier), 0) >= LOCKOUT_THRESHOLD


def record_failure(request, user, identifier, *, via="api"):
    """Count one failed attempt (user may be None for an unknown identifier)
    and lock the account when the threshold is reached. Returns True when the
    caller should now be told the account is locked."""
    if user is None:
        key = _unknown_key(identifier)
        count = cache.get(key, 0) + 1
        cache.set(key, count, int(LOCKOUT_DURATION.total_seconds()))
        log_action(request, "auth.login_failed", entity_type="User",
                   description=f"Failed sign-in for unknown identifier ({via}).")
        return count >= LOCKOUT_THRESHOLD

    now = timezone.now()
    users = type(user).objects.filter(pk=user.pk)
    # A stale count from a lock that has already expired starts afresh.
    users.filter(locked_until__lte=now).update(failed_login_count=0, locked_until=None)
    # Incremented in SQL, so parallel guesses can't overwrite each other's count.
    users.update(failed_login_count=F("failed_login_count") + 1)
    user.refresh_from_db(fields=["failed_login_count", "locked_until"])
    locked_now = user.failed_login_count >= LOCKOUT_THRESHOLD and not is_locked(user)
    if locked_now:
        user.locked_until = now + LOCKOUT_DURATION
        users.update(locked_until=user.locked_until)
    log_action(request, "auth.login_failed", user=user, entity_type="User", entity_id=user.pk,
               description=f"Failed sign-in for {user.username} "
                           f"({user.failed_login_count}/{LOCKOUT_THRESHOLD}, {via}).")
    if locked_now:
        log_action(request, "auth.account_locked", user=user, entity_type="User", entity_id=user.pk,
                   description=f"{user.username} locked for 15 minutes after "
                               f"{LOCKOUT_THRESHOLD} failed sign-ins.")
    return locked_now


def record_success(user):
    """Clear the failure count after a successful sign-in."""
    if user.failed_login_count or user.locked_until:
        user.failed_login_count = 0
        user.locked_until = None
        user.save(update_fields=["failed_login_count", "locked_until"])


def unlock(request, user, *, by=None):
    """Lift a lock early (Admin action). Always audit-logged."""
    user.failed_login_count = 0
    user.locked_until = None
    user.save(update_fields=["failed_login_count", "locked_until"])
    actor = by or getattr(request, "user", None)
    log_action(request, "auth.account_unlocked", user=actor if getattr(actor, "is_authenticated", False) else None,
               entity_type="User", entity_id=user.pk,
               description=f"Unlocked {user.username}"
                           + (f" (by {actor.username})." if getattr(actor, "username", "") else "."))
