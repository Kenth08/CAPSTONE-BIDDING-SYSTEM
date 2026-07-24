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
            fail_silently=True,
        )
    except Exception:
        logger.exception("Failed to send verification email to %s", user.email)
