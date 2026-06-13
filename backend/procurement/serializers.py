from rest_framework import serializers

from .models import Award, Bid, Document, Project, Supplier


class SupplierSerializer(serializers.ModelSerializer):
    class Meta:
        model = Supplier
        fields = [
            "id", "company", "contact", "business_type", "status",
            "qualification_status", "email_verified", "registered",
        ]


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
