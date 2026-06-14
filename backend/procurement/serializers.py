from rest_framework import serializers

from .models import (
    PROCUREMENT_CATEGORIES,
    PROCUREMENT_DOCUMENT_FIELDS,
    SUPPLIER_DOCUMENT_FIELDS,
    Award,
    Bid,
    Document,
    Notification,
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
    bid_count = serializers.SerializerMethodField()
    documents = serializers.SerializerMethodField()

    def get_bid_count(self, obj):
        # Prefer the annotated value (list/detail) — falls back to the model
        # property only for freshly-created objects that weren't annotated.
        val = getattr(obj, "num_bids", None)
        return val if val is not None else obj.bid_count

    def get_documents(self, obj):
        """Read-side view of the procurement documents: {key,label,required,url}.
        The Head review screen uses this to show/download what the Admin uploaded."""
        request = self.context.get("request")
        out = []
        for key, label, required in PROCUREMENT_DOCUMENT_FIELDS:
            f = getattr(obj, key, None)
            url = (request.build_absolute_uri(f.url) if request else f.url) if f else None
            out.append({"key": key, "label": label, "required": required, "url": url})
        return out

    def validate(self, attrs):
        # Enforce the realistic "complete procurement" rules only when creating.
        if self.instance is None:
            if attrs.get("category") not in PROCUREMENT_CATEGORIES:
                raise serializers.ValidationError({"category": "Select a valid procurement category."})
            required_fields = {
                "type": "Procurement Type", "delivery_location": "Delivery Location",
                "deadline": "Bid Submission Deadline", "expected_delivery_date": "Expected Delivery Date",
            }
            for field, label in required_fields.items():
                if not attrs.get(field):
                    raise serializers.ValidationError({field: f"{label} is required."})
            if not attrs.get("budget") or attrs["budget"] <= 0:
                raise serializers.ValidationError({"budget": "Enter the Approved Budget (ABC)."})
            missing = [label for key, label, req in PROCUREMENT_DOCUMENT_FIELDS if req and not attrs.get(key)]
            if missing:
                raise serializers.ValidationError(
                    {"documents": "Upload all required documents: " + ", ".join(missing) + "."})
        return attrs

    class Meta:
        model = Project
        fields = [
            "id", "code", "name", "description", "budget", "deadline",
            "type", "category", "delivery_location", "expected_delivery_date",
            "eligible_types", "status", "bid_count", "created_at",
            "reviewed_at", "reject_reason", "documents",
            # write-only file inputs (read side is exposed via `documents`)
            "purchase_request", "technical_specifications", "terms_of_reference",
            "approved_budget_document", "bid_evaluation_criteria",
        ]
        # Status transitions only happen through the approve/reject/publish
        # actions, never by directly writing the field.
        read_only_fields = ["code", "created_at", "status", "reviewed_at", "reject_reason"]
        extra_kwargs = {
            key: {"write_only": True, "required": False}
            for key, _, _ in PROCUREMENT_DOCUMENT_FIELDS
        }


class BidSerializer(serializers.ModelSerializer):
    project_name = serializers.CharField(source="project.name", read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True)
    project_category = serializers.CharField(source="project.category", read_only=True)
    supplier_name = serializers.CharField(source="supplier.company", read_only=True)

    class Meta:
        model = Bid
        fields = [
            "id", "project", "project_name", "project_code", "project_category",
            "supplier", "supplier_name", "amount", "notes", "status", "submitted_at",
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


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = ["id", "message", "link", "is_read", "created_at"]
