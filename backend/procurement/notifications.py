"""Helpers for creating in-app notifications.

Centralising this keeps notification creation consistent across the views and
makes it safe: a notification is only ever addressed to a specific user, and a
failure to notify never breaks the action that triggered it (notifications are
best-effort, the business transition is what matters).
"""

import logging

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import send_mail

from .models import Notification

logger = logging.getLogger(__name__)
User = get_user_model()


def email_user(user, subject, message):
    """Best-effort email alongside an in-app notification, for events a
    supplier needs to know about even if they don't have the dashboard open
    (bid results, qualification decisions). Never raises — a failed or
    unconfigured SMTP server must never break the action that triggered it."""
    if not getattr(user, "email", None):
        return
    try:
        send_mail(
            subject=subject,
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            fail_silently=True,
        )
    except Exception:  # pragma: no cover - email must never break the flow
        logger.exception("Failed to email %s: %s", user.email, subject)


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


def notify_supplier(supplier, message, link="", email_subject=None):
    """Notify the account behind a supplier profile, if it has one.

    Pass `email_subject` to also email this message — reserved for events the
    supplier needs to know about even if they never open the dashboard (bid
    results, qualification decisions); routine notices stay in-app only."""
    user = getattr(supplier, "user", None)
    if not user:
        return
    notify_users([user], message, link)
    if email_subject:
        email_user(user, email_subject, message)
