"""Tell a supplier when one of their documents needs attention.

Three alerts, each sent once:

* EXPIRED — a document's expiry date has passed. An expired required
  document stops counting, so the supplier can lose eligibility to bid.
* EXPIRING — it expires within EXPIRING_SOON_DAYS (30). Sent once per expiry
  date, so a renewal with a new date can warn again next time.
* MISSING — a required document was never uploaded.

There is no background worker in this system, so alerts are raised from two
places: when the supplier opens their dashboard (`/suppliers/me/`, in-app
only, they are already looking) and from `manage.py notify_document_expiry`
(in-app AND email), which can run daily from a scheduler so a supplier who
doesn't sign in still hears about it.

"Once" is decided by the notification text itself: the same message is never
created twice for the same user. The message names the document and its
expiry date, so a renewed document with a later date gets fresh alerts. This
needs no new table or migration.

Never raises: an alert is a courtesy and must not break the page that
triggered it.
"""
import logging

from django.utils import timezone

from .document_requirements import (
    EXPIRED,
    NOT_UPLOADED,
    approved_categories,
    document_status,
    requirements_for,
)
from .models import Notification
from .notifications import notify_supplier

logger = logging.getLogger(__name__)

PROFILE_LINK = "/supplier/profile"


def _date(value):
    return value.strftime("%b %d, %Y").replace(" 0", " ")


def document_alerts(supplier, *, today=None):
    """The alert messages this supplier's documents call for right now, as
    [(kind, message)]. Reads only the database (no storage round trips)."""
    today = today or timezone.localdate()
    rows = {row.key: row for row in supplier.category_documents.all()}
    alerts = []
    for req in requirements_for(approved_categories(supplier)):
        status = document_status(supplier, req, rows=rows, check_storage=False, today=today)
        label, expiry = req["label"], status["expiry_date"]
        if status["reason"] == EXPIRED:
            alerts.append(("expired", (
                f"Your {label} expired on {_date(expiry)}. Upload the renewed copy from My Profile"
                + (" so you can keep bidding." if req["required"] else ".")
            )))
        elif status["expiring_soon"]:
            alerts.append(("expiring", (
                f"Your {label} expires on {_date(expiry)}. Upload the renewed copy from My Profile "
                "before then."
            )))
        elif status["reason"] == NOT_UPLOADED and req["required"]:
            alerts.append(("missing", (
                f"Your {label} is missing. Upload it from My Profile so the BAC office can "
                "complete your review."
            )))
    return alerts


def send_document_alerts(supplier, *, email=False, today=None, dry_run=False):
    """Create the alerts this supplier hasn't had yet. Returns the messages
    that were (or, with dry_run, would be) sent. Never raises."""
    user = getattr(supplier, "user", None)
    if user is None:
        return []
    try:
        alerts = document_alerts(supplier, today=today)
        if not alerts:
            return []
        # One query for all of them: each query costs a round trip to the
        # database, and this runs when the supplier opens their dashboard.
        # The stored message is cut to 300 characters; compare the same way.
        already = set(Notification.objects.filter(
            user=user, message__in=[m[:300] for _, m in alerts]).values_list("message", flat=True))
        sent = []
        for kind, message in alerts:
            if message[:300] in already:
                continue
            sent.append(message)
            if dry_run:
                continue
            subject = None
            if email:
                subject = {"expired": "A document has expired", "expiring": "A document expires soon",
                           "missing": "A required document is missing"}[kind]
            notify_supplier(supplier, message, link=PROFILE_LINK, email_subject=subject)
        return sent
    except Exception:  # noqa: BLE001 — alerts must never break the caller
        logger.exception("Document alerts failed for supplier %s", getattr(supplier, "pk", "?"))
        return []
