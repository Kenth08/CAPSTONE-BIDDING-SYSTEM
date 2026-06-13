from django.contrib import admin

from .models import Award, Bid, Document, Project, Supplier


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "budget", "status", "deadline", "created_at")
    list_filter = ("status", "type")
    search_fields = ("code", "name")


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ("company", "contact", "tin", "status", "qualification_status", "registered")
    list_filter = ("status", "qualification_status")
    list_editable = ("qualification_status",)
    search_fields = ("company", "contact", "tin", "user__email")


@admin.register(Bid)
class BidAdmin(admin.ModelAdmin):
    list_display = ("project", "supplier", "amount", "status", "submitted_at")
    list_filter = ("status",)


@admin.register(Award)
class AwardAdmin(admin.ModelAdmin):
    list_display = ("project", "supplier", "amount", "status", "awarded_at")
    list_filter = ("status",)


@admin.register(Document)
class DocumentAdmin(admin.ModelAdmin):
    list_display = ("supplier", "doc_type", "expiry_date")
