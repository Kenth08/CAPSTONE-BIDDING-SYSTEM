from rest_framework import serializers

from .models import (
    SUPPLIER_DOCUMENT_FIELDS,
    Award,
    Bid,
    Document,
    Project,
    Supplier,
)


class SupplierListSerializer(serializers.ModelSerializer):
    """Lightweight rows for the admin Suppliers table."""

    full_name = serializers.CharField(source="user.full_name", read_only=True, default="")
    email = serializers.EmailField(source="user.email", read_only=True, default="")

    class Meta:
        model = Supplier
        fields = [
            "id", "company", "contact", "full_name", "email", "business_type",
            "status", "qualification_status", "email_verified", "registered",
        ]


# Backwards-compatible alias (other code/imports may still reference SupplierSerializer).
SupplierSerializer = SupplierListSerializer


class SupplierDetailSerializer(serializers.ModelSerializer):
    """Full supplier profile + uploaded documents for the admin review modal
    and the supplier's own dashboard."""

    full_name = serializers.CharField(source="user.full_name", read_only=True, default="")
    email = serializers.EmailField(source="user.email", read_only=True, default="")
    documents = serializers.SerializerMethodField()

    class Meta:
        model = Supplier
        fields = [
            "id", "company", "contact", "full_name", "email", "business_type",
            "business_types", "company_address", "phone_number", "tin",
            "representative_name", "track_record_description",
            "mayors_permit_expiry", "tax_clearance_expiry", "financial_statement_year",
            "status", "qualification_status", "email_verified", "registered",
            "declaration_accepted", "admin_notes", "document_reviews", "reviewed_at",
            "documents",
        ]

    def get_documents(self, obj):
        request = self.context.get("request")
        reviews = obj.document_reviews or {}
        result = []
        for key, label, required in SUPPLIER_DOCUMENT_FIELDS:
            file = getattr(obj, key, None)
            url = None
            if file:
                url = request.build_absolute_uri(file.url) if request else file.url
            review = reviews.get(key) or {}
            result.append({
                "key": key,
                "label": label,
                "required": required,
                "url": url,
                "review_status": review.get("status"),
                "review_note": review.get("note", ""),
            })
        return result


class ProjectSerializer(serializers.ModelSerializer):
    bid_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Project
        fields = [
            "id", "code", "name", "description", "budget", "deadline",
            "type", "eligible_types", "status", "bid_count", "created_at",
        ]
        read_only_fields = ["code", "created_at"]


class BidSerializer(serializers.ModelSerializer):
    project_name = serializers.CharField(source="project.name", read_only=True)
    supplier_name = serializers.CharField(source="supplier.company", read_only=True)

    class Meta:
        model = Bid
        fields = [
            "id", "project", "project_name", "supplier", "supplier_name",
            "amount", "status", "submitted_at",
        ]


class AwardSerializer(serializers.ModelSerializer):
    project_name = serializers.CharField(source="project.name", read_only=True)
    supplier_name = serializers.CharField(source="supplier.company", read_only=True)

    class Meta:
        model = Award
        fields = [
            "id", "project", "project_name", "supplier", "supplier_name",
            "bid", "amount", "status", "awarded_at",
        ]


class DocumentSerializer(serializers.ModelSerializer):
    company = serializers.CharField(source="supplier.company", read_only=True)

    class Meta:
        model = Document
        fields = ["id", "supplier", "company", "doc_type", "expiry_date"]
