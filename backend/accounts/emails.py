"""Email-verification link generation + delivery.

Uses the same scheme as Django's password-reset tokens (user pk + password
hash + a timestamp, so it self-invalidates once used), but with a distinct
key_salt so a verification link can never be replayed as a password-reset
token and vice versa.
"""

import logging

from django.conf import settings
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.mail import send_mail
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode

logger = logging.getLogger(__name__)


class EmailVerificationTokenGenerator(PasswordResetTokenGenerator):
    key_salt = "accounts.EmailVerificationTokenGenerator"

    def _make_hash_value(self, user, timestamp):
        """The base class hashes `last_login`, which is right for a password
        reset but wrong here: a newly registered supplier is expected to sign in
        before opening the email, and that sign-in silently invalidated the
        link. The address itself is hashed instead, so a link only ever
        confirms the email it was sent to (changing the email voids it), and the
        password hash keeps a reset from leaving old links alive.

        NOTE: links issued before this change no longer validate; the supplier
        resends one from their dashboard."""
        return f"{user.pk}{user.password}{(user.email or '').lower()}{timestamp}"


email_verification_token = EmailVerificationTokenGenerator()


def send_verification_email(user):
    """Email a one-time confirmation link to `user`. Best-effort: a failed or
    unconfigured SMTP server must never break registration (mirrors how
    PasswordResetRequestView never lets mail delivery fail the request)."""
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = email_verification_token.make_token(user)
    frontend = (settings.FRONTEND_URL or "http://localhost:3000").rstrip("/")
    link = f"{frontend}/verify-email?uid={uid}&token={token}"
    try:
        send_mail(
            subject="Verify your E-Procurement email address",
            message=(
                f"Hi {user.full_name or user.username},\n\n"
                "Please confirm your email address to complete your supplier "
                "registration. This link is valid for 3 days:\n\n"
                f"{link}\n\n"
                "If you didn't request this, you can safely ignore this email."
            ),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            # False on purpose: the try/except around this logs the failure.
            # fail_silently=True swallowed SMTP errors before the log line ran,
            # so undelivered mail left no trace anywhere.
            fail_silently=False,
        )
    except Exception:
        logger.exception("Failed to send verification email to %s", user.email)
