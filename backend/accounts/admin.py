from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class CustomUserAdmin(UserAdmin):
    list_display = ("username", "email", "role", "full_name", "is_staff")
    list_filter = ("role", "is_staff", "is_superuser")
    fieldsets = UserAdmin.fieldsets + (
        ("Procurement", {"fields": ("role", "full_name")}),
    )
