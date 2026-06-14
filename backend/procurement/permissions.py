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
