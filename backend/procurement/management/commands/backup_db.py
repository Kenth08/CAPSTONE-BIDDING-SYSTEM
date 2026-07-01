"""
Usage:
    python manage.py backup_db                # writes to backups/ in the project root
    python manage.py backup_db -o /tmp/dumps  # custom output directory

The backup is a JSON dump of the accounts + procurement apps produced by
Django's dumpdata command.  It can be reloaded with:
    python manage.py loaddata <file>

Supabase also creates automatic daily backups (7-day retention on the free
tier; Point-in-Time Recovery available on the Pro plan via the dashboard at
Settings → Database → Backups).  This command adds an on-demand safety net.
"""

import os
from datetime import datetime
from io import StringIO

from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Export accounts + procurement data to a timestamped JSON backup file."

    def add_arguments(self, parser):
        parser.add_argument(
            "--output-dir", "-o",
            default="backups",
            help="Directory to write the backup file (default: backups/).",
        )

    def handle(self, *args, **options):
        output_dir = options["output_dir"]
        os.makedirs(output_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = os.path.join(output_dir, f"backup_{timestamp}.json")

        buf = StringIO()
        call_command(
            "dumpdata",
            "accounts",
            "procurement",
            indent=2,
            stdout=buf,
            natural_foreign=True,
            natural_primary=True,
        )

        with open(filename, "w", encoding="utf-8") as f:
            f.write(buf.getvalue())

        size_kb = os.path.getsize(filename) / 1024
        self.stdout.write(
            self.style.SUCCESS(f"Backup saved: {filename}  ({size_kb:.1f} KB)")
        )
        self.stdout.write("To restore: python manage.py loaddata <file>")
