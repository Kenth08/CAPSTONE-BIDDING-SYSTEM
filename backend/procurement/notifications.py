"""Helpers for creating in-app notifications.

Centralising this keeps notification creation consistent across the views and
makes it safe: a notification is only ever addressed to a specific user, and a
failure to notify never breaks the action that triggered it (notifications are
best-effort, the business transition is what matters).
"""

import logging

from django.contrib.auth import get_user_model

from .models import Notification

logger = logging.getLogger(__name__)
User = get_user_model()


def notify_users(users, message, link=""):
    """Create one notification per user. `users` may be a queryset or iterable.

    Skips falsy entries (e.g. a supplier with no linked account) and de-duplicates
    so a user is never notified twice for the same event.
    """
    seen = set()
    objs = []
    for user in users:
        if not user or user.pk in seen:
            continue
        seen.add(user.pk)
        objs.append(Notification(user=user, message=message[:300], link=link[:200]))
    if not objs:
        return
    try:
        Notification.objects.bulk_create(objs)
    except Exception:  # pragma: no cover - notifications must never break the flow
        logger.exception("Failed to create notifications: %s", message)


def notify_role(role, message, link=""):
    """Notify every active user with the given role (e.g. all admins, all heads)."""
    notify_users(User.objects.filter(role=role, is_active=True), message, link)


def notify_admins(message, link=""):
    notify_role(User.Role.ADMIN, message, link)


def notify_heads(message, link=""):
    notify_role(User.Role.HEAD, message, link)


def notify_supplier(supplier, message, link=""):
    """Notify the account behind a supplier profile, if it has one."""
    user = getattr(supplier, "user", None)
    if user:
        notify_users([user], message, link)
