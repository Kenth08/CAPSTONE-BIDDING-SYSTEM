from rest_framework import permissions


class IsAdminRole(permissions.BasePermission):
    """Allow only authenticated users whose account role is 'admin'."""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, "role", None) == "admin")


class IsSupplierRole(permissions.BasePermission):
    """Allow only authenticated users whose account role is 'supplier'."""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, "role", None) == "supplier")


class IsHeadRole(permissions.BasePermission):
    """Allow only authenticated users whose account role is 'head'."""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, "role", None) == "head")


class IsAdminOrHeadRole(permissions.BasePermission):
    """Allow authenticated 'admin' or 'head' accounts.

    Used by the project blockchain-anchor endpoint: both roles cause project
    status transitions (Admin creates/publishes, Head approves/rejects), so both
    need to be able to attach the resulting transaction hash. Suppliers attach
    their own bid anchors through /bids/{id}/anchor/ instead, which is already
    scoped to their own bids."""

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user and user.is_authenticated and getattr(user, "role", None) in {"admin", "head"}
        )
