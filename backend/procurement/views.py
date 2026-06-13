from datetime import date

from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Award, Bid, Document, Project, Supplier
from .serializers import (
    AwardSerializer,
    BidSerializer,
    DocumentSerializer,
    ProjectSerializer,
    SupplierSerializer,
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
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer


class BidViewSet(viewsets.ModelViewSet):
    queryset = Bid.objects.select_related("project", "supplier").all()
    serializer_class = BidSerializer


class AwardViewSet(viewsets.ModelViewSet):
    queryset = Award.objects.select_related("project", "supplier").all()
    serializer_class = AwardSerializer


class DocumentViewSet(viewsets.ModelViewSet):
    queryset = Document.objects.select_related("supplier").all()
    serializer_class = DocumentSerializer
