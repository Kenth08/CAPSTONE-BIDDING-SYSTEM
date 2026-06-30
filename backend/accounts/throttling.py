import re

from rest_framework.throttling import SimpleRateThrottle


class IPRateThrottle(SimpleRateThrottle):
    """Base for IP-keyed throttles on unauthenticated routes (login, register).

    DRF's built-in rate parser only understands single-unit windows ('5/min',
    '5/hour'), so this overrides parse_rate to accept a multi-unit window like
    '5/15m'. Subclasses just set `scope` to a matching key in
    DEFAULT_THROTTLE_RATES — keyed by IP since there's no account yet to key by.
    """

    def parse_rate(self, rate):
        if rate is None:
            return (None, None)
        num, period = rate.split("/")
        # period like '15m', '15min', '2h', 's', 'd' → (count, unit-seconds)
        match = re.match(r"(\d+)?\s*([smhd])", period.strip())
        if not match:
            raise ValueError(f"Invalid throttle rate period: {period!r}")
        count = int(match.group(1) or 1)
        unit_seconds = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]
        return (int(num), count * unit_seconds)

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class LoginRateThrottle(IPRateThrottle):
    """Strict throttle for the login route: max 5 attempts per 15 minutes per IP.
    This is what blunts brute-force/credential-stuffing against the auth endpoint."""

    scope = "login"


class RegisterRateThrottle(IPRateThrottle):
    """Throttle for account-creation routes: max 10 registrations per hour per IP.

    Generous enough that a genuine applicant retrying after a validation error
    (typo, weak password, mismatched confirm-password) is never blocked, while
    still stopping scripted mass account creation.
    """

    scope = "register"


class PasswordResetRateThrottle(IPRateThrottle):
    """Throttle for the password reset request/confirm routes: max 5 per hour
    per IP. Stops the request endpoint from being used to mass-email/enumerate
    accounts, and stops the confirm endpoint from being used to brute-force a
    reset token, while still leaving room for a genuine user who mistypes
    their email or fat-fingers their new password once or twice."""

    scope = "password_reset"


class EmailVerifyRateThrottle(IPRateThrottle):
    """Throttle for email verification confirm/resend: max 5 per hour per IP —
    same reasoning as PasswordResetRateThrottle (stops token brute-forcing /
    resend-mail spam, leaves room for a genuine retry)."""

    scope = "email_verify"
