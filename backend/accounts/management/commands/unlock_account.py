"""Lift a temporary sign-in lockout from the command line.

    python manage.py unlock_account <username-or-email>

For when the only Admin is the one locked out. Audit-logged as a system action.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from accounts import lockout


class Command(BaseCommand):
    help = "Unlock an account locked after repeated failed sign-ins."

    def add_arguments(self, parser):
        parser.add_argument("identifier", help="Username or email of the account.")

    def handle(self, *args, **options):
        ident = options["identifier"].strip()
        user = get_user_model().objects.filter(Q(username__iexact=ident) | Q(email__iexact=ident)).first()
        if user is None:
            raise CommandError(f"No account matches {ident!r}.")
        lockout.unlock(None, user)
        self.stdout.write(self.style.SUCCESS(f"{user.username} unlocked."))
