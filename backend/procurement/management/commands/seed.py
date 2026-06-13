"""Seed the database with the demo data the frontend currently hardcodes.

Run:  python manage.py seed
Idempotent-ish: clears procurement tables first, then recreates.
"""
from datetime import date

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from procurement.models import Award, Bid, Document, Project, Supplier

User = get_user_model()


class Command(BaseCommand):
    help = "Load demo procurement data and role accounts."

    def handle(self, *args, **options):
        # --- Role accounts -------------------------------------------------
        # username == email; log in with the email address.
        # (username, email, password, role, full_name, is_super)
        accounts = [
            ("admin@gmail.com", "admin@gmail.com", "admin123", "admin", "System Administrator", True),
            ("head@gmail.com", "head@gmail.com", "head123", "head", "Department Head", False),
            ("supplier", "supplier@gmail.com", "password123", "supplier", "Kenthcharles Repollo", False),
        ]
        # Remove any older demo accounts that used the bare role as a username.
        User.objects.filter(username__in=["admin", "head"]).delete()
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
            business_type="IT Equipment, ICT Services",
            status=Supplier.Status.DRAFT,
            qualification_status=Supplier.Qualification.VERIFIED,
            email_verified=True,
        )
        s2 = Supplier.objects.create(
            company="PA co.",
            contact="coc",
            business_type="ICT Services",
            status=Supplier.Status.APPROVED,
            qualification_status=Supplier.Qualification.PENDING,
            email_verified=True,
        )

        # --- Projects ------------------------------------------------------
        p1 = Project.objects.create(
            code="P-2026-001", name="computer", budget=2000,
            deadline=date(2026, 6, 3), type="ICT Services",
            status=Project.Status.AWARDED,
            description="Procurement of computer units for office use.",
        )
        p2 = Project.objects.create(
            code="P-2026-002", name="chair/table", budget=100000,
            deadline=date(2026, 7, 10), type="IT Equipment",
            status=Project.Status.AWARDED,
            description="Procurement of chairs and tables for conference rooms.",
        )

        # --- Bids ----------------------------------------------------------
        b1 = Bid.objects.create(project=p1, supplier=s1, amount=1000, status=Bid.Status.WON)
        b2 = Bid.objects.create(project=p2, supplier=s1, amount=100000, status=Bid.Status.WON)

        # --- Awards --------------------------------------------------------
        Award.objects.create(project=p1, supplier=s1, bid=b1, amount=1000)
        Award.objects.create(project=p2, supplier=s1, bid=b2, amount=100000)

        # --- Documents -----------------------------------------------------
        Document.objects.create(supplier=s1, doc_type="Mayor's Permit", expiry_date=date(2026, 7, 4))
        Document.objects.create(supplier=s1, doc_type="Tax Clearance", expiry_date=date(2026, 7, 3))

        self.stdout.write(self.style.SUCCESS("Seed complete: 2 projects, 2 suppliers, 2 bids, 2 awards, 2 documents."))
