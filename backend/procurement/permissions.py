from django.conf import settings
from rest_framework import permissions

# Accounts that work inside the procuring entity. They may READ every
# procurement's internal record; what each may CHANGE is decided by the
# classes below. Suppliers and the public are never in this set.
INTERNAL_ROLES = frozenset({"admin", "staff", "bac", "head"})


def bac_workflow_on():
    """Is separation of duties switched on (settings.BAC_WORKFLOW_ENABLED)?

    Off: the original workflow, the Admin prepares, evaluates and awards.
    On: Staff prepare, the BAC Committee evaluates and recommends, the Head
    approves the award, and the Admin only oversees. Read at request time so
    tests can override the setting."""
    return bool(getattr(settings, "BAC_WORKFLOW_ENABLED", False))


def _role(request):
    user = request.user
    if not (user and user.is_authenticated):
        return None
    return getattr(user, "role", None)


def preparer_roles():
    """Who prepares, publishes and issues documents for a procurement.

    Staff always may, so their accounts can be set up and tried before the
    switch. The Admin keeps the job only while the workflow is off."""
    return {"staff"} if bac_workflow_on() else {"admin", "staff"}


class IsAdminRole(permissions.BasePermission):
    """Allow only authenticated users whose account role is 'admin'."""

    def has_permission(self, request, view):
        return _role(request) == "admin"


class IsSupplierRole(permissions.BasePermission):
    """Allow only authenticated users whose account role is 'supplier'."""

    def has_permission(self, request, view):
        return _role(request) == "supplier"


class IsHeadRole(permissions.BasePermission):
    """Allow only authenticated users whose account role is 'head'."""

    def has_permission(self, request, view):
        return _role(request) == "head"


class IsStaffRole(permissions.BasePermission):
    """Allow only Procurement Staff (BAC Secretariat) accounts."""

    def has_permission(self, request, view):
        return _role(request) == "staff"


class IsBACRole(permissions.BasePermission):
    """Allow only BAC Committee accounts. Whether the account currently holds a
    seat (an active BACMembership) is checked by the action itself."""

    def has_permission(self, request, view):
        return _role(request) == "bac"


class IsInternalRole(permissions.BasePermission):
    """Read access for anyone inside the procuring entity (INTERNAL_ROLES)."""

    def has_permission(self, request, view):
        return _role(request) in INTERNAL_ROLES


class IsPreparerRole(permissions.BasePermission):
    """Prepares procurements: creates, edits, submits, publishes and issues the
    post-award documents. Staff, plus the Admin while the workflow is off."""

    message = "Procurement Staff prepare and publish procurements."

    def has_permission(self, request, view):
        return _role(request) in preparer_roles()


class IsAdminOrStaffRole(permissions.BasePermission):
    """The procurement office: the Admin and Procurement Staff. Used for the
    supplier registry (registrations, category requests, compliance documents),
    where the Admin manages accounts and Staff keep the records, and for the
    office dashboard summary."""

    def has_permission(self, request, view):
        return _role(request) in {"admin", "staff"}


class IsLegacyEvaluatorRole(permissions.BasePermission):
    """The original one-person evaluation and award (qualify, disqualify,
    select winner, bid document review): the Admin, only while the workflow is
    off. Once it is on, the BAC Committee evaluates and the Head approves the
    award instead, so these endpoints refuse everyone."""

    message = ("Bids are evaluated by the BAC Committee and the award is approved by the Head, "
               "so this action is no longer available.")

    def has_permission(self, request, view):
        return not bac_workflow_on() and _role(request) == "admin"


class IsBidReviewerRole(permissions.BasePermission):
    """Asks a bidder to fix a document: the Admin while the workflow is off,
    the BAC Committee once it is on (they are the ones evaluating)."""

    def has_permission(self, request, view):
        return _role(request) == ("bac" if bac_workflow_on() else "admin")


class IsAdminOrHeadRole(permissions.BasePermission):
    """Allow the accounts that cause project transitions to attach the
    resulting transaction hash: whoever prepares (Admin or Staff, see
    preparer_roles) and the Head (approvals and, with the workflow on, the
    award). Suppliers attach their own bid anchors through /bids/{id}/anchor/
    instead, which is already scoped to their own bids.

    The name is kept from when only the Admin and the Head could."""

    def has_permission(self, request, view):
        return _role(request) in preparer_roles() | {"head"}


class IsAnchorSignerRole(permissions.BasePermission):
    """Who may re-check a procurement's anchors against the chain
    (ProjectViewSet.verify_chain): the Admin (oversight), Staff and the Head."""

    def has_permission(self, request, view):
        return _role(request) in {"admin", "staff", "head"}
