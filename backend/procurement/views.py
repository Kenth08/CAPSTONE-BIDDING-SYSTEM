from datetime import date

from django.utils import timezone
from rest_framework import status as http_status
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response

from .models import (
    SUPPLIER_DOCUMENT_KEYS,
    Award,
    Bid,
    Document,
    Project,
    Supplier,
)
from .permissions import IsAdminRole, IsSupplierRole
from .serializers import (
    AwardSerializer,
    BidSerializer,
    DocumentSerializer,
    ProjectSerializer,
    SupplierDetailSerializer,
    SupplierListSerializer,
)


class ProjectViewSet(viewsets.ModelViewSet):
    queryset = Project.objects.all()
    serializer_class = ProjectSerializer

    def perform_create(self, serializer):
        # Auto-generate a code like P-2026-001
        year = date.today().year
        count = Project.objects.filter(code__startswith=f"P-{year}-").count() + 1
        code = f"P-{year}-{count:03d}"
        user = self.request.user if self.request.user.is_authenticated else None
        serializer.save(code=code, created_by=user)

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None):
        project = self.get_object()
        project.status = Project.Status.PUBLISHED
        project.save()
        return Response(self.get_serializer(project).data)

    @action(detail=False, methods=["get"])
    def stats(self, request):
        qs = Project.objects.all()
        return Response({
            "total_projects": qs.count(),
            "active_bidding": qs.filter(status=Project.Status.PUBLISHED).count(),
            "awarded_contracts": qs.filter(status=Project.Status.AWARDED).count(),
            "total_bids": Bid.objects.count(),
        })


class SupplierViewSet(viewsets.ModelViewSet):
    queryset = Supplier.objects.select_related("user").all()
    serializer_class = SupplierListSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    # Admins manage/review suppliers; suppliers may only read/resubmit their own
    # profile through the `me` / `resubmit` actions.
    SUPPLIER_ACTIONS = {"me", "resubmit"}

    def get_serializer_class(self):
        if self.action in {"retrieve", "me", "resubmit", "approve", "reject", "request_revision"}:
            return SupplierDetailSerializer
        return SupplierListSerializer

    def get_permissions(self):
        if self.action in self.SUPPLIER_ACTIONS:
            return [IsSupplierRole()]
        return [IsAdminRole()]

    def _detail_response(self, supplier, status_code=http_status.HTTP_200_OK):
        data = SupplierDetailSerializer(supplier, context={"request": self.request}).data
        return Response(data, status=status_code)

    # ── Supplier's own profile ────────────────────────────────────────────
    def _own_supplier(self, request):
        return Supplier.objects.select_related("user").filter(user=request.user).first()

    @action(detail=False, methods=["get"])
    def me(self, request):
        supplier = self._own_supplier(request)
        if supplier is None:
            return Response({"detail": "No supplier profile found."}, status=http_status.HTTP_404_NOT_FOUND)
        return self._detail_response(supplier)

    @action(detail=False, methods=["post"])
    def resubmit(self, request):
        """Supplier re-uploads documents the admin flagged, then re-enters the queue."""
        supplier = self._own_supplier(request)
        if supplier is None:
            return Response({"detail": "No supplier profile found."}, status=http_status.HTTP_404_NOT_FOUND)

        reviews = dict(supplier.document_reviews or {})
        updated = []
        for key in SUPPLIER_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded:
                setattr(supplier, key, uploaded)
                reviews.pop(key, None)  # clear the revision flag for this doc
                updated.append(key)

        if not updated:
            return Response(
                {"detail": "Upload at least one document to resubmit."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        supplier.document_reviews = reviews
        supplier.qualification_status = Supplier.Qualification.PENDING
        supplier.reviewed_at = None
        supplier.save()
        return self._detail_response(supplier)

    # ── Admin review decisions ────────────────────────────────────────────
    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        supplier = self.get_object()
        supplier.status = Supplier.Status.APPROVED
        supplier.qualification_status = Supplier.Qualification.VERIFIED
        supplier.document_reviews = {}  # clear any outstanding revision flags
        supplier.admin_notes = request.data.get("note", "") or supplier.admin_notes
        supplier.reviewed_at = timezone.now()
        supplier.save()
        return self._detail_response(supplier)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        supplier = self.get_object()
        supplier.qualification_status = Supplier.Qualification.REJECTED
        supplier.admin_notes = request.data.get("note", "")
        supplier.reviewed_at = timezone.now()
        supplier.save()
        return self._detail_response(supplier)

    @action(detail=True, methods=["post"], url_path="request-revision")
    def request_revision(self, request, pk=None):
        supplier = self.get_object()
        documents = request.data.get("documents") or {}
        if not isinstance(documents, dict) or not documents:
            return Response(
                {"detail": "Flag at least one document for revision."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        reviews = {}
        for key, note in documents.items():
            if key not in SUPPLIER_DOCUMENT_KEYS:
                return Response(
                    {"detail": f"Unknown document '{key}'."},
                    status=http_status.HTTP_400_BAD_REQUEST,
                )
            reviews[key] = {"status": "needs_revision", "note": note or ""}

        supplier.document_reviews = reviews
        supplier.qualification_status = Supplier.Qualification.NEEDS_REVISION
        supplier.admin_notes = request.data.get("note", "")
        supplier.reviewed_at = timezone.now()
        supplier.save()
        return self._detail_response(supplier)


class BidViewSet(viewsets.ModelViewSet):
    queryset = Bid.objects.select_related("project", "supplier").all()
    serializer_class = BidSerializer


class AwardViewSet(viewsets.ModelViewSet):
    queryset = Award.objects.select_related("project", "supplier").all()
    serializer_class = AwardSerializer


class DocumentViewSet(viewsets.ModelViewSet):
    queryset = Document.objects.select_related("supplier").all()
    serializer_class = DocumentSerializer
