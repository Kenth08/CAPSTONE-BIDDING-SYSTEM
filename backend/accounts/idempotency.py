"""Tell the browser how a write ended when the connection was cut first.

WHY
---
The live host's router gives up on a request after 30 seconds and answers the
browser itself, with a 503 that carries no CORS headers. The browser can't even
read it, so it reports "Cannot reach the server". The dyno doesn't know and
keeps working. On 2026-11-10 that happened to supplier registrations, a new
procurement and a bid over a slow venue network: each was saved 15-120 seconds
after the browser had called it a failure. People submitted again, which made
a duplicate procurement and a registration that collided with itself.

HOW
---
1. The browser sends a random `Idempotency-Key` header with a write
   (frontend/src/api.js).
2. This middleware records a PENDING RequestOutcome under that key before the
   view runs, and stores the status and JSON body once the view answers.
3. When the connection drops or the router answers 502/503/504, the browser
   polls GET /api/auth/requests/<key>/ (RequestOutcomeView) and uses the stored
   answer as if it had arrived normally. It submits again only when the server
   never saw the request.

The same key sent twice while the first is pending, or after it succeeded, is
refused with 409 rather than run again. A key whose request failed (4xx/5xx)
may be sent again: that is the access-token refresh retry in api.js, which
resends the same request after a 401.

WHAT IS NEVER RECORDED
----------------------
Anything whose answer is a credential: sign-in, MFA, token refresh, password
reset, logout, email verification, and the one-time download links
(`.../link/`). The only /api/auth/ writes recorded are the two supplier
registration forms. A request without the header, or with a malformed one,
passes through untouched, so old browsers and scripts behave as before.

FAILURE
-------
Recording is best-effort. If the table can't be written (for example a
deploy that hasn't migrated yet), the request runs exactly as it would without
this middleware.
"""
import json
import logging
import random
import re
from datetime import timedelta

from django.db import DatabaseError, IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from .models import RequestOutcome

logger = logging.getLogger(__name__)

HEADER = "HTTP_IDEMPOTENCY_KEY"
KEY_PATTERN = re.compile(r"^[A-Za-z0-9-]{16,64}$")
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# The only /api/auth/ writes worth recording: their answers hold no credential.
RECORDED_AUTH_PATHS = frozenset({
    "/api/auth/register/supplier/",
    "/api/auth/admin/register-supplier/",
})

# A pending row older than this belongs to a worker that died mid-request.
STALE_PENDING = timedelta(minutes=15)
# How long outcomes are kept. The browser asks within minutes.
RETENTION = timedelta(days=1)
# Bodies bigger than this are not stored; the browser then reloads instead.
MAX_BODY_BYTES = 256 * 1024
# Roughly one write in this many also prunes old rows.
PRUNE_ONE_IN = 50


def is_recorded(method, path):
    if method not in WRITE_METHODS:
        return False
    if path.startswith("/api/auth/"):
        return path in RECORDED_AUTH_PATHS
    if path.endswith("/link/"):
        return False
    return path.startswith("/api/")


def _start(key, request):
    """The PENDING row for this request, or a 409 response when the key is
    already in use. None when nothing could be recorded."""
    try:
        with transaction.atomic():
            return RequestOutcome.objects.create(
                key=key, method=request.method, path=request.path[:300])
    except IntegrityError:
        pass
    except DatabaseError:
        logger.exception("Could not record request outcome for %s %s", request.method, request.path)
        return None

    existing = RequestOutcome.objects.filter(key=key).first()
    if existing is None:
        return None
    if existing.method != request.method or existing.path != request.path[:300]:
        return _conflict("This request id was already used for a different request.")
    retry_allowed = (
        (existing.state == RequestOutcome.State.DONE and (existing.status_code or 0) >= 400)
        or (existing.state == RequestOutcome.State.PENDING
            and existing.created_at < timezone.now() - STALE_PENDING)
    )
    if not retry_allowed:
        return _conflict(
            "This request is already being processed or has finished. "
            "Refresh the page to see the result before submitting again.")
    # Claim it back. The filter makes two simultaneous retries settle on one.
    claimed = RequestOutcome.objects.filter(
        pk=existing.pk, state=existing.state, status_code=existing.status_code,
    ).update(state=RequestOutcome.State.PENDING, status_code=None, body="",
             finished_at=None, created_at=timezone.now())
    if not claimed:
        return _conflict("This request is already being processed.")
    existing.refresh_from_db()
    return existing


def _conflict(detail):
    return JsonResponse({"detail": detail, "code": "duplicate_request"}, status=409)


def _finish(outcome, request, response):
    body = ""
    content_type = response.get("Content-Type", "")
    if not getattr(response, "streaming", False) and content_type.startswith("application/json"):
        content = response.content
        if len(content) <= MAX_BODY_BYTES:
            body = content.decode("utf-8", errors="replace")
    user = getattr(request, "user", None)   # DRF copies its user onto the request
    try:
        RequestOutcome.objects.filter(pk=outcome.pk).update(
            state=RequestOutcome.State.DONE,
            status_code=response.status_code,
            body=body,
            user=user if getattr(user, "is_authenticated", False) else None,
            finished_at=timezone.now(),
        )
        if random.randrange(PRUNE_ONE_IN) == 0:
            RequestOutcome.objects.filter(created_at__lt=timezone.now() - RETENTION).delete()
    except DatabaseError:
        logger.exception("Could not store request outcome %s", outcome.pk)


class IdempotencyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        key = request.META.get(HEADER, "")
        if not key or not KEY_PATTERN.match(key) or not is_recorded(request.method, request.path):
            return self.get_response(request)
        started = _start(key, request)
        if started is None:
            return self.get_response(request)
        if isinstance(started, JsonResponse):
            return started
        response = self.get_response(request)
        _finish(started, request, response)
        return response


class RequestOutcomeView(APIView):
    """GET /api/auth/requests/<key>/ -> how the write sent with that key ended.

        {"state": "unknown"}                     never seen (or not yours)
        {"state": "pending"}                     still running
        {"state": "done", "status": 201, "body": {...}}

    A recorded user's outcome is shown only to that user; for anyone else it is
    "unknown", which reveals nothing. An outcome with no user (a registration)
    needs only the key, a random value only the submitting browser has."""

    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "request_status"

    def get(self, request, key):
        outcome = RequestOutcome.objects.filter(key=key).first() if KEY_PATTERN.match(key) else None
        if outcome is not None and outcome.user_id is not None and outcome.user_id != request.user.pk:
            outcome = None
        if outcome is None:
            return Response({"state": "unknown"})
        if outcome.state == RequestOutcome.State.PENDING:
            if outcome.created_at < timezone.now() - STALE_PENDING:
                return Response({"state": "unknown"})
            return Response({"state": "pending"})
        try:
            body = json.loads(outcome.body) if outcome.body else None
        except ValueError:
            body = None
        return Response({"state": "done", "status": outcome.status_code, "body": body})
