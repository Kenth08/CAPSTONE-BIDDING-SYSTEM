from rest_framework import serializers

from .models import (
    PROCUREMENT_CATEGORIES,
    PROCUREMENT_DOCUMENT_FIELDS,
    SUPPLIER_DOCUMENT_FIELDS,
    Award,
    Bid,
    BidAttachment,
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
            "business_types", "status", "qualification_status", "email_verified", "registered",
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


class SupplierMeUpdateSerializer(serializers.ModelSerializer):
    """Fields a supplier may edit about their own profile from the Settings page.

    Company name, TIN and business types are excluded — they were verified at
    registration and changing them silently would undermine that review.
    """

    class Meta:
        model = Supplier
        fields = ["phone_number", "company_address", "representative_name"]

    def validate_phone_number(self, value):
        if value and not value.isdigit():
            raise serializers.ValidationError("Phone number must contain digits only.")
        return value


class ProjectSerializer(serializers.ModelSerializer):
    bid_count = serializers.SerializerMethodField()
    documents = serializers.SerializerMethodField()
    reference_image_url = serializers.SerializerMethodField()

    def get_reference_image_url(self, obj):
        """Absolute URL of the optional reference image, or None when there
        isn't one — so the frontend never renders a broken/empty image box."""
        f = getattr(obj, "reference_image", None)
        if not f:
            return None
        request = self.context.get("request")
        return request.build_absolute_uri(f.url) if request else f.url

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
            "reviewed_at", "reject_reason", "published_at", "awarded_at", "documents",
            # write-only file inputs (read side is exposed via `documents`)
            "purchase_request", "technical_specifications", "terms_of_reference",
            "approved_budget_document", "bid_evaluation_criteria",
            # optional reference image: write via `reference_image`, read via URL
            "reference_image", "reference_image_url",
        ]
        # Status transitions only happen through the approve/reject/publish
        # actions, never by directly writing the field.
        read_only_fields = [
            "code", "created_at", "status", "reviewed_at", "reject_reason",
            "published_at", "awarded_at",
        ]
        extra_kwargs = {
            **{
                key: {"write_only": True, "required": False}
                for key, _, _ in PROCUREMENT_DOCUMENT_FIELDS
            },
            # Image is purely optional and write-only (read side is reference_image_url).
            "reference_image": {"write_only": True, "required": False},
        }


class BidAttachmentSerializer(serializers.ModelSerializer):
    """One "Other Attachment" file with an absolute, openable URL."""

    url = serializers.SerializerMethodField()

    class Meta:
        model = BidAttachment
        fields = ["id", "file_name", "url", "uploaded_at"]

    def get_url(self, obj):
        if not obj.file:
            return None
        request = self.context.get("request")
        return request.build_absolute_uri(obj.file.url) if request else obj.file.url


class BidSerializer(serializers.ModelSerializer):
    project_name = serializers.CharField(source="project.name", read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True)
    project_category = serializers.CharField(source="project.category", read_only=True)
    supplier_name = serializers.CharField(source="supplier.company", read_only=True)

    # Absolute URLs for every uploaded file (None when not provided, so the UI
    # never renders a broken link).
    quotation_document_url = serializers.SerializerMethodField()
    technical_document_url = serializers.SerializerMethodField()
    supplier_product_image_url = serializers.SerializerMethodField()
    supplier_datasheet_url = serializers.SerializerMethodField()
    supplier_compliance_doc_url = serializers.SerializerMethodField()
    attachments = BidAttachmentSerializer(many=True, read_only=True)

    class Meta:
        model = Bid
        fields = [
            "id", "project", "project_name", "project_code", "project_category",
            "supplier", "supplier_name", "amount", "notes", "status", "submitted_at", "reviewed_at",
            # required + product info
            "delivery_timeline", "additional_comments",
            "brand_name", "model_number", "warranty_period",
            # file URLs (read side)
            "quotation_document_url", "technical_document_url",
            "supplier_product_image_url", "supplier_datasheet_url",
            "supplier_compliance_doc_url", "attachments",
            # declarations
            "terms_accepted", "interest_declared", "scm_declared",
            "accuracy_confirmed", "specification_confirmed",
        ]

    def _abs_url(self, file):
        if not file:
            return None
        request = self.context.get("request")
        return request.build_absolute_uri(file.url) if request else file.url

    def get_quotation_document_url(self, obj):
        return self._abs_url(obj.quotation_document)

    def get_technical_document_url(self, obj):
        return self._abs_url(obj.technical_document)

    def get_supplier_product_image_url(self, obj):
        return self._abs_url(obj.supplier_product_image)

    def get_supplier_datasheet_url(self, obj):
        return self._abs_url(obj.supplier_datasheet)

    def get_supplier_compliance_doc_url(self, obj):
        return self._abs_url(obj.supplier_compliance_doc)


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
