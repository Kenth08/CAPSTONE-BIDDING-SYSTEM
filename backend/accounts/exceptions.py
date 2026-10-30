"""DRF exception handler that audit-logs refused requests.

A signed-in user hitting an endpoint their role may not use (a supplier calling
an Admin action, a Head trying to evaluate bids) is either a UI bug or someone
probing — worth a line in the audit log either way. Anonymous 401s are not
logged: every expired token produces one and they would drown the log. File
requests that are refused with a 404 are logged by procurement/files.py.
"""
from rest_framework.exceptions import PermissionDenied
from rest_framework.views import exception_handler as drf_exception_handler

from .audit import log_action


def audit_exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    if isinstance(exc, PermissionDenied):
        request = context.get("request")
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            view = context.get("view")
            log_action(
                request, "auth.permission_denied", user=user,
                entity_type=type(view).__name__ if view else "",
                description=f"{request.method} {request.path} refused for role "
                            f"{getattr(user, 'role', '?')}.",
            )
    return response
