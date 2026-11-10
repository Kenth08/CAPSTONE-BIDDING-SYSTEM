"""Small response-header middleware not covered by Django's SecurityMiddleware."""

# Browser features this API never needs. Denying them means a page served from
# this origin (the Django admin, an error page) can't be abused to reach them.
PERMISSIONS_POLICY = (
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), "
    "microphone=(), payment=(), usb=(), interest-cohort=()"
)


class PermissionsPolicyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.headers.setdefault("Permissions-Policy", PERMISSIONS_POLICY)
        return response


class SlowRequestLogMiddleware:
    """Log every request slower than SLOW_REQUEST_SECONDS, with how much of it
    was spent in the database.

    On 2026-11-10 writes on the live system took 50-150 seconds and the logs
    showed only the platform's timeout, not where the time went. This line
    answers that: "12.4s total, 31 queries in 7.9s" points at the database (the
    app and the database are in different regions), while few queries in a slow
    request point at storage uploads, email or the blockchain node instead.

    Queries are counted on this thread's connection only; work on helper
    threads (see project_documents._stored_states) shows up as non-query time."""

    def __init__(self, get_response):
        import os  # noqa: PLC0415
        self.get_response = get_response
        self.threshold = float(os.environ.get("SLOW_REQUEST_SECONDS", "3"))

    def __call__(self, request):
        import logging  # noqa: PLC0415
        import time  # noqa: PLC0415

        from django.db import connection  # noqa: PLC0415

        stats = {"count": 0, "seconds": 0.0}

        def timed(execute, sql, params, many, context):
            started = time.perf_counter()
            try:
                return execute(sql, params, many, context)
            finally:
                stats["count"] += 1
                stats["seconds"] += time.perf_counter() - started

        started = time.perf_counter()
        with connection.execute_wrapper(timed):
            response = self.get_response(request)
        elapsed = time.perf_counter() - started
        if elapsed >= self.threshold:
            logging.getLogger("slow_requests").warning(
                "Slow request %s %s -> %s: %.1fs total, %d queries in %.1fs",
                request.method, request.path, response.status_code,
                elapsed, stats["count"], stats["seconds"])
        return response
