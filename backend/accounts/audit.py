"""Audit logging helper.

`log_action` records one significant action in the AuditLog table. Call it from
a view *after* the action has succeeded. It deliberately swallows every
exception: auditing is a side effect, and a failure to record it must never turn
a successful operation into an error for the user.
"""
import logging

from .models import AuditLog

logger = logging.getLogger(__name__)


def get_client_ip(request):
    """Best-effort client IP. Honours X-Forwarded-For because the app runs behind
    a proxy in production (Render), where REMOTE_ADDR is the proxy, not the user."""
    if request is None:
        return None
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        # First hop is the original client; the rest are proxies.
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


def log_action(request, action, *, entity_type="", entity_id="", description="", user=None):
    """Record one audit entry. Never raises.

    user defaults to request.user (when authenticated); pass it explicitly for
    flows where request.user isn't set yet, such as login."""
    try:
        if user is None and request is not None:
            candidate = getattr(request, "user", None)
            if candidate is not None and getattr(candidate, "is_authenticated", False):
                user = candidate
        AuditLog.objects.create(
            user=user,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id not in (None, "") else "",
            description=(description or "")[:300],
            ip_address=get_client_ip(request),
        )
    except Exception:  # pragma: no cover — auditing must never break the request
        logger.exception("Failed to write audit log for action %r", action)
