from django.contrib import admin

from .models import Award, Bid, BlockchainAnchor, Document, Project, Supplier


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


@admin.register(BlockchainAnchor)
class BlockchainAnchorAdmin(admin.ModelAdmin):
    """Read-only by design — the anchor trail is evidence, not editable data.
    Being able to edit a data_hash here would defeat the entire point of it."""

    list_display = ("entity_ref", "entity_type", "stage", "short_hash", "tx_hash", "block_number", "created_at")
    list_filter = ("entity_type", "stage")
    search_fields = ("entity_ref", "data_hash", "tx_hash")
    date_hierarchy = "created_at"

    def short_hash(self, obj):
        return obj.data_hash[:18] + "…"
    short_hash.short_description = "data hash"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
