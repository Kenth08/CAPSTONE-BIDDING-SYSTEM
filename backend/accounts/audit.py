"""Audit logging helper.

`log_action` records one significant action in the AuditLog table. Call it from
a view *after* the action has succeeded. It deliberately swallows every
exception: auditing is a side effect, and a failure to record it must never turn
a successful operation into an error for the user.
"""
import ipaddress
import logging

from django.conf import settings

from .models import AuditLog

logger = logging.getLogger(__name__)


def get_client_ip(request):
    """The client IP, using the same trust rule as the rate limits.

    The leftmost X-Forwarded-For entry is whatever the client chose to send, so
    trusting it let anyone write a fake IP into the audit log. Only the entries
    appended by our own proxies (settings.TRUSTED_PROXY_COUNT of them, counted
    from the right) can be believed. Returns None for anything that isn't a
    valid IP address, so a garbage header can't break the audit write."""
    if request is None:
        return None
    proxies = getattr(settings, "TRUSTED_PROXY_COUNT", 0)
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if proxies and forwarded:
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        candidate = hops[-min(proxies, len(hops))] if hops else ""
    else:
        candidate = request.META.get("REMOTE_ADDR", "")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


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
