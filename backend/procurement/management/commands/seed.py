"""Seed the database with the demo data the frontend currently hardcodes.

Run:  python manage.py seed
Idempotent-ish: clears procurement tables first, then recreates.

DESTRUCTIVE — this deletes every award, bid, document, project and supplier
before rebuilding the demo rows, and resets the three role accounts to their
well-known demo passwords. That is exactly what you want on a local dev
database and never what you want on the deployed one.

WHY THE GUARD LOOKS AT THE DATABASE, NOT JUST DEBUG
---------------------------------------------------
This command used to refuse only when DEBUG=False. But backend/.env points
DB_HOST at the live Supabase instance and leaves DEBUG unset (so it defaults to
True) — which meant `python manage.py seed` on a developer machine passed the
guard and wiped PRODUCTION. The guard therefore inspects the connection Django
is actually about to use, and refuses unconditionally (no flag overrides it)
when:

  * the database is anything other than SQLite on a local host — a remote
    Postgres is treated as production, whatever DEBUG says;
  * the process is running on the hosting platform (Render markers in env);
  * DEBUG=False (a production-shaped configuration).

On a safe local database that already contains data, wiping it still needs the
explicit --wipe-local-data flag. A fresh, empty database seeds without one,
because there is nothing to destroy.
"""
import os
from datetime import date

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import connections, transaction

from procurement.models import Award, Bid, Document, Project, Supplier

User = get_user_model()

LOCAL_DB_HOSTS = {"", "localhost", "127.0.0.1", "::1"}
# Set by Render on every service; any one of them means "this is the deployment".
HOSTING_ENV_MARKERS = ("RENDER", "RENDER_SERVICE_ID", "RENDER_EXTERNAL_HOSTNAME")


def database_settings():
    """The settings of the connection this command would write to. A function
    (not a module constant) so tests can substitute a production-shaped one."""
    return connections["default"].settings_dict


def unsafe_target_reason(db_settings, *, debug, environ):
    """Why seeding this database must be refused outright, or None if it is a
    local development database. Pure, so every refusal path is unit-testable."""
    engine = db_settings.get("ENGINE", "")
    host = str(db_settings.get("HOST") or "").strip().lower()
    if not engine.endswith("sqlite3"):
        if host not in LOCAL_DB_HOSTS:
            return (f"the database is a remote server ({host}). Remote databases are treated "
                    "as production and are never seeded")
        # A local non-SQLite server could still be a tunnel to production; the
        # demo data only needs SQLite, so refuse rather than guess.
        return "the database is not SQLite. Seed only targets a local SQLite database"
    for marker in HOSTING_ENV_MARKERS:
        if environ.get(marker):
            return f"this process is running on the hosting platform ({marker} is set)"
    if not debug:
        return "DEBUG=False, so this is a production-shaped configuration"
    return None


def has_existing_data():
    return (User.objects.exists() or Project.objects.exists()
            or Supplier.objects.exists() or Bid.objects.exists() or Award.objects.exists())


class Command(BaseCommand):
    help = "Load demo procurement data and role accounts (local SQLite development only)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe-local-data",
            action="store_true",
            help="Confirm that the existing data in the LOCAL SQLite database may be deleted. "
                 "Has no effect on a remote/production database, which is always refused.",
        )

    def handle(self, *args, **options):
        # Every check runs before anything is written, so a refused run exits
        # without touching a single row.
        reason = unsafe_target_reason(database_settings(), debug=settings.DEBUG, environ=os.environ)
        if reason:
            raise CommandError(
                f"Refusing to seed: {reason}. Seeding deletes all procurement data and resets "
                "the role accounts to demo passwords. To seed locally, run with DB_HOST unset "
                "(e.g. `DB_HOST= python manage.py seed`) so Django uses the local SQLite file."
            )
        if has_existing_data() and not options["wipe_local_data"]:
            raise CommandError(
                "Refusing to seed: the local database already contains data, which seeding "
                "would delete. Re-run with --wipe-local-data to confirm."
            )

        # All-or-nothing: a failure part-way must not leave half the demo data.
        with transaction.atomic():
            self._seed()

    def _seed(self):

        # --- Role accounts -------------------------------------------------
        # Admin and Head can sign in with either their plain username
        # (admin / head) or their email address below.
        # (username, email, password, role, full_name, is_super)
        accounts = [
            ("admin", "admin@gmail.com", "admin123", "admin", "System Administrator", True),
            ("head", "head@gmail.com", "head123", "head", "Department Head", False),
            ("supplier", "supplier@gmail.com", "password123", "supplier", "Kenthcharles Repollo", False),
        ]
        # Clean up any older demo accounts (email-based or bare-role variants).
        User.objects.filter(username__in=["admin", "head", "admin@gmail.com", "head@gmail.com"]).delete()
        for username, email, password, role, full_name, is_super in accounts:
            user, created = User.objects.get_or_create(
                username=username,
                defaults={"email": email, "role": role, "full_name": full_name},
            )
            user.role = role
            user.full_name = full_name
            user.email = email
            user.is_staff = is_super
            user.is_superuser = is_super
            user.set_password(password)
            user.save()
            self.stdout.write(f"  user: {username} / {password} ({role})")

        # --- Clear existing demo rows -------------------------------------
        Award.objects.all().delete()
        Bid.objects.all().delete()
        Document.objects.all().delete()
        Project.objects.all().delete()
        Supplier.objects.all().delete()

        # --- Suppliers -----------------------------------------------------
        supplier_user = User.objects.get(username="supplier")
        s1 = Supplier.objects.create(
            user=supplier_user,
            company="PA co.",
            contact="Kenthcharles Repollo",
            business_type="IT Equipment, Office Supplies",
            business_types=["IT Equipment", "Office Supplies"],
            status=Supplier.Status.DRAFT,
            qualification_status=Supplier.Qualification.VERIFIED,
            email_verified=True,
        )
        s2 = Supplier.objects.create(
            company="BuildRight Inc.",
            contact="coc",
            business_type="Construction",
            business_types=["Construction"],
            status=Supplier.Status.APPROVED,
            qualification_status=Supplier.Qualification.PENDING,
            email_verified=True,
        )

        # --- Projects ------------------------------------------------------
        # Already published-awarded in the past — keep explicit deadline/delivery
        # dates (the cycle already ran its course) plus the periods that produced them.
        p1 = Project.objects.create(
            code="P-2026-001", name="computer", budget=2000,
            deadline=date(2026, 6, 3), bidding_period_days=14, type="Goods", category="IT Equipment",
            delivery_location="Main Campus",
            expected_delivery_date=date(2026, 6, 20), delivery_period_days=14,
            status=Project.Status.AWARDED,
            description="Procurement of computer units for office use.",
        )
        p2 = Project.objects.create(
            code="P-2026-002", name="chair/table", budget=100000,
            deadline=date(2026, 7, 10), bidding_period_days=14, type="Goods", category="Furniture",
            delivery_location="Main Campus",
            expected_delivery_date=date(2026, 7, 25), delivery_period_days=30,
            status=Project.Status.AWARDED,
            description="Procurement of chairs and tables for conference rooms.",
        )
        # Awaiting the Head's approval (shows in Head → Pending Approval). Not
        # published/awarded yet, so only PERIODS are set — no deadline or
        # delivery date exists until Publish/select-winner respectively.
        Project.objects.create(
            code="P-2026-003", name="IT Systems Upgrade", budget=450000,
            bidding_period_days=21, type="Goods", category="IT Equipment",
            delivery_location="Main Campus", delivery_period_days=60,
            status=Project.Status.PENDING_HEAD,
            description="Upgrade of school IT infrastructure and network systems, "
                        "including hardware replacement and software licensing.",
        )
        # Approved by the Head (shows in Admin → Projects) but not yet
        # published/awarded — same "no date until the milestone happens" rule.
        Project.objects.create(
            code="P-2026-004", name="Hospital Equipment Procurement", budget=890000,
            bidding_period_days=14, type="Goods", category="Medical Supplies",
            delivery_location="District Hospital", delivery_period_days=30,
            status=Project.Status.APPROVED,
            description="Procurement of medical equipment for the district hospital.",
        )

        # --- Bids ----------------------------------------------------------
        b1 = Bid.objects.create(project=p1, supplier=s1, amount=1000, status=Bid.Status.WINNER)
        b2 = Bid.objects.create(project=p2, supplier=s1, amount=100000, status=Bid.Status.WINNER)

        # --- Awards --------------------------------------------------------
        Award.objects.create(project=p1, supplier=s1, bid=b1, amount=1000)
        Award.objects.create(project=p2, supplier=s1, bid=b2, amount=100000)

        # --- Documents -----------------------------------------------------
        Document.objects.create(supplier=s1, doc_type="Mayor's Permit", expiry_date=date(2026, 7, 4))
        Document.objects.create(supplier=s1, doc_type="Tax Clearance", expiry_date=date(2026, 7, 3))

        self.stdout.write(self.style.SUCCESS("Seed complete: 4 projects, 2 suppliers, 2 bids, 2 awards, 2 documents."))
