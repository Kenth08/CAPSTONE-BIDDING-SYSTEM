import re

from rest_framework.throttling import SimpleRateThrottle


class LoginRateThrottle(SimpleRateThrottle):
    """Strict throttle for the login route: max 5 attempts per 15 minutes per IP.

    DRF's built-in rate parser only understands single-unit windows ('5/min',
    '5/hour'), so we override parse_rate to accept a multi-unit window like
    '5/15m'. Login is unauthenticated, so attempts are keyed by client IP — this
    is what blunts brute-force/credential-stuffing against the auth endpoint.
    """

    scope = "login"

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
        # Always key by IP (the user isn't authenticated yet during login).
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
