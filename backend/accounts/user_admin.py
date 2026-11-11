"""Account management for the Admin (separation of duties, docs/BAC_ROLES_PLAN.md).

The Admin creates and deactivates the accounts of the procuring entity's
people: Procurement Staff, BAC Committee members and the Head. It can't create
another Admin (that stays a deliberate, out-of-band act through the Django
admin or the seed command), can't create suppliers (they register themselves
and go through verification), and can't change anyone's role afterwards: a
person who changes job gets a new account, so the history of the old one stays
attributed to the role it had.

Accounts are deactivated, never deleted, so evaluations, votes and the audit
log keep pointing at a real person.
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import generics, serializers, status
from rest_framework.response import Response

from procurement.permissions import IsAdminRole

from .audit import log_action
from .names import apply_name, resolve_name

User = get_user_model()

# The roles the Admin may create through this endpoint.
MANAGED_ROLES = (User.Role.STAFF, User.Role.BAC, User.Role.HEAD)


class ManagedUserSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=False, trim_whitespace=False)
    role_label = serializers.CharField(source="get_role_display", read_only=True)
    bac_position = serializers.SerializerMethodField()
    locked = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "username", "email", "full_name", "first_name", "middle_name", "last_name",
                  "role", "role_label", "is_active",
                  "mfa_enabled", "last_login", "date_joined", "bac_position", "locked", "password"]
        read_only_fields = ["id", "full_name", "is_active", "mfa_enabled", "last_login", "date_joined"]

    def get_bac_position(self, user):
        seat = next((m for m in user.bac_memberships.all() if m.active), None)
        return seat.get_position_display() if seat else ""

    def get_locked(self, user):
        from . import lockout  # noqa: PLC0415

        return lockout.is_locked(user)

    def validate_username(self, value):
        value = value.strip()
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("That username is already taken.")
        return value

    def validate_email(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("An email address is required.")
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("Another account already uses this email address.")
        return value

    def validate_role(self, value):
        if value not in MANAGED_ROLES:
            raise serializers.ValidationError(
                "Choose Procurement Staff, BAC Committee or Head. Admin accounts can't be created "
                "here, and suppliers register themselves.")
        return value

    def validate(self, attrs):
        if self.instance is None:
            attrs["_name"] = resolve_name(self.initial_data)
            password = attrs.get("password") or ""
            if not password:
                raise serializers.ValidationError({"password": "Set a temporary password."})
            try:
                validate_password(password, user=User(username=attrs.get("username", ""),
                                                      email=attrs.get("email", "")))
            except DjangoValidationError as exc:
                raise serializers.ValidationError({"password": list(exc.messages)}) from exc
        return attrs

    def create(self, validated_data):
        password = validated_data.pop("password")
        resolved = validated_data.pop("_name")
        for key in ("first_name", "middle_name", "last_name"):
            validated_data.pop(key, None)
        user = User(**validated_data)
        apply_name(user, resolved)
        user.set_password(password)
        user.save()
        return user


class ManagedUserUpdateSerializer(serializers.ModelSerializer):
    """What the Admin may change on an existing account: name and email, and
    whether it is active. Never the role, the username or the password."""

    class Meta:
        model = User
        fields = ["first_name", "middle_name", "last_name", "email", "is_active"]

    def validate_email(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("An email address is required.")
        if User.objects.filter(email__iexact=value).exclude(pk=self.instance.pk).exists():
            raise serializers.ValidationError("Another account already uses this email address.")
        return value


def _managed_users():
    return (User.objects.filter(role__in=[*MANAGED_ROLES, User.Role.ADMIN])
            .prefetch_related("bac_memberships").order_by("-date_joined", "-id"))  # newest account first


class ManagedUserListCreateView(generics.ListCreateAPIView):
    """GET the procuring entity's accounts (Admin, Staff, BAC, Head);
    POST {username, email, full_name, role, password} to create one."""

    permission_classes = [IsAdminRole]
    serializer_class = ManagedUserSerializer

    def get_queryset(self):
        return _managed_users()

    def perform_create(self, serializer):
        user = serializer.save()
        log_action(self.request, "user.created", entity_type="User", entity_id=user.pk,
                   description=f"Created {user.get_role_display()} account {user.username}.")


class ManagedUserDetailView(generics.RetrieveUpdateAPIView):
    """PATCH {full_name?, email?, is_active?} on a Staff, BAC or Head account."""

    permission_classes = [IsAdminRole]
    http_method_names = ["get", "patch", "head", "options"]

    def get_queryset(self):
        return _managed_users()

    def get_serializer_class(self):
        return ManagedUserSerializer if self.request.method == "GET" else ManagedUserUpdateSerializer

    def partial_update(self, request, *args, **kwargs):
        user = self.get_object()
        if user.role not in MANAGED_ROLES:
            return Response({"detail": "Admin accounts are managed outside this page."},
                            status=status.HTTP_403_FORBIDDEN)
        serializer = ManagedUserUpdateSerializer(user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        deactivating = user.is_active and serializer.validated_data.get("is_active") is False
        if deactivating and user.bac_memberships.filter(active=True).exists():
            return Response(
                {"detail": "This person still holds a seat on the BAC Committee. End their "
                           "designation first, then deactivate the account."},
                status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            serializer.save()
            resolved = resolve_name(request.data, required=False)
            if resolved is not None:
                apply_name(user, resolved)
                user.save(update_fields=["first_name", "middle_name", "last_name", "full_name"])
        changed = ", ".join(sorted(serializer.validated_data)) or "nothing"
        log_action(request, "user.deactivated" if deactivating else "user.updated",
                   entity_type="User", entity_id=user.pk,
                   description=f"{'Deactivated' if deactivating else 'Updated'} {user.username} ({changed}).")
        return Response(ManagedUserSerializer(user).data)
