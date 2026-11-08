"""Warn suppliers about expired, expiring and missing documents.

    python manage.py notify_document_expiry --dry-run   # list what would be sent
    python manage.py notify_document_expiry             # send (in-app + email)

Each alert is sent once (see procurement/document_alerts.py), so this is safe
to run every day, for example from Heroku Scheduler:

    python manage.py notify_document_expiry

Only active supplier accounts are checked. Rejected suppliers are skipped:
they can't bid anyway, and the alert would only confuse them.
"""
from django.core.management.base import BaseCommand

from procurement.document_alerts import send_document_alerts
from procurement.models import Supplier


class Command(BaseCommand):
    help = "Notify suppliers (in-app and email) about expired, expiring or missing documents."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="Only list the alerts that would be sent.")

    def handle(self, *args, dry_run=False, **options):
        suppliers = (Supplier.objects.select_related("user").prefetch_related("category_documents")
                     .filter(user__is_active=True)
                     .exclude(qualification_status=Supplier.Qualification.REJECTED))
        total = 0
        for supplier in suppliers:
            sent = send_document_alerts(supplier, email=True, dry_run=dry_run)
            for message in sent:
                self.stdout.write(f"{supplier.company}: {message}")
            total += len(sent)
        verb = "would be sent" if dry_run else "sent"
        self.stdout.write(self.style.SUCCESS(f"{total} alert(s) {verb}."))
