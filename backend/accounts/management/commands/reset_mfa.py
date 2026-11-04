"""Remove two-factor authentication from an account whose authenticator was
lost and whose backup codes are used up or gone.

    python manage.py reset_mfa <username-or-email>

The user signs in with their password next time and is walked through setting
up a new authenticator. Audit-logged. Verify the person's identity first —
this removes their second factor.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from accounts import mfa


class Command(BaseCommand):
    help = "Reset two-factor authentication for a user (they re-enroll at next sign-in)."

    def add_arguments(self, parser):
        parser.add_argument("identifier", help="Username or email of the account.")

    def handle(self, *args, **options):
        ident = options["identifier"].strip()
        user = get_user_model().objects.filter(Q(username__iexact=ident) | Q(email__iexact=ident)).first()
        if user is None:
            raise CommandError(f"No account matches {ident!r}.")
        mfa.reset(user, by="manage.py reset_mfa")
        self.stdout.write(self.style.SUCCESS(
            f"Two-factor authentication reset for {user.username}. They will set it up again "
            "at their next sign-in."))
