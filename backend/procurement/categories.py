"""Procurement categories: the built-in list plus the ones the Admin adds.

GET  /api/categories/  -> {"categories": [...names...]}   anyone (supplier registration needs it)
POST /api/categories/  {"name": "..."}                    Admin only

Adding is idempotent on the name ignoring case and spacing: posting
"it  equipment" returns the existing "IT Equipment" with 200 instead of
creating a near-duplicate. A new category starts with no eligible suppliers;
suppliers opt in at registration or through a category change in Settings."""

from django.db import IntegrityError, transaction
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.audit import log_action

from .models import CATEGORY_NAME_MAX_LENGTH, ProcurementCategory, all_categories, find_category
from .permissions import IsPreparerRole


class CategoryView(APIView):
    def get_permissions(self):
        if self.request.method == "GET":
            return [permissions.AllowAny()]
        # New categories are added from the Planning form, by whoever prepares.
        return [IsPreparerRole()]

    def get_authenticators(self):
        # The list is public; don't let a stale token turn a GET into a 401.
        if getattr(self, "request", None) is not None and self.request.method == "GET":
            return []
        return super().get_authenticators()

    def get(self, request):
        return Response({"categories": all_categories()})

    def post(self, request):
        raw = request.data.get("name") if isinstance(request.data, dict) else None
        name = " ".join(str(raw or "").split())
        if not name:
            return Response({"name": "Enter a category name."}, status=status.HTTP_400_BAD_REQUEST)
        if len(name) > CATEGORY_NAME_MAX_LENGTH:
            return Response({"name": f"Keep the name under {CATEGORY_NAME_MAX_LENGTH} characters."},
                            status=status.HTTP_400_BAD_REQUEST)
        if "," in name:
            # business_type is stored comma-joined for display; a comma would split it.
            return Response({"name": "A category name can't contain a comma."},
                            status=status.HTTP_400_BAD_REQUEST)

        existing = find_category(name)
        if existing:
            return Response({"name": existing, "created": False, "categories": all_categories()})
        try:
            with transaction.atomic():
                category = ProcurementCategory.objects.create(name=name, created_by=request.user)
        except IntegrityError:
            # Another request added it a moment ago.
            return Response({"name": find_category(name) or name, "created": False,
                             "categories": all_categories()})
        log_action(request, "category.added", entity_type="ProcurementCategory",
                   entity_id=str(category.pk),
                   description=f"Added procurement category '{name}'."[:300])
        return Response({"name": name, "created": True, "categories": all_categories()},
                        status=status.HTTP_201_CREATED)
