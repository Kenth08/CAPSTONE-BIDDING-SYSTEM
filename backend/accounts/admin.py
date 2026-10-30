from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from . import lockout
from .admin_site import SecureAdminAuthenticationForm
from .models import AuditLog, User

# The admin login gets the same lockout and audit logging as the API login.
admin.site.login_form = SecureAdminAuthenticationForm


@admin.register(User)
class CustomUserAdmin(UserAdmin):
    list_display = ("username", "email", "role", "full_name", "is_staff", "locked_until")
    list_filter = ("role", "is_staff", "is_superuser")
    fieldsets = UserAdmin.fieldsets + (
        ("Procurement", {"fields": ("role", "full_name")}),
        ("Sign-in protection", {"fields": ("failed_login_count", "locked_until")}),
    )
    readonly_fields = ("failed_login_count", "locked_until")
    actions = ["unlock_accounts"]

    @admin.action(description="Unlock selected accounts")
    def unlock_accounts(self, request, queryset):
        for user in queryset:
            lockout.unlock(request, user)
        self.message_user(request, f"Unlocked {queryset.count()} account(s).")


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    """Read-only view of the audit trail. Entries are written by the app, never
    by hand — so creating, editing, and deleting are all disabled to keep the
    log trustworthy."""

    list_display = ("created_at", "user", "action", "entity_type", "entity_id", "ip_address")
    list_filter = ("action", "entity_type", "created_at")
    search_fields = ("action", "entity_type", "entity_id", "description", "user__username")
    date_hierarchy = "created_at"
    readonly_fields = (
        "user", "action", "entity_type", "entity_id", "description",
        "ip_address", "created_at",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
