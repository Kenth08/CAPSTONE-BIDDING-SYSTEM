from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count
from django.utils import timezone
from rest_framework import status as http_status
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    BID_DOCUMENT_FIELDS,
    BID_DOCUMENT_KEYS,
    PROCUREMENT_DOCUMENT_FIELDS,
    PROCUREMENT_DOCUMENT_KEYS,
    SUPPLIER_DOCUMENT_FIELDS,
    SUPPLIER_DOCUMENT_KEYS,
    Award,
    Bid,
    BidAttachment,
    Document,
    Notification,
    Project,
    Supplier,
)
from rest_framework import permissions

from .notifications import email_user, notify_admins, notify_heads, notify_supplier, notify_users
from .permissions import IsAdminRole, IsHeadRole, IsSupplierRole
from .serializers import (
    AwardSerializer,
    BidSerializer,
    DocumentSerializer,
    NotificationSerializer,
    ProjectSerializer,
    SupplierDetailSerializer,
    SupplierListSerializer,
    SupplierMeUpdateSerializer,
)
from .validators import validate_bid_upload, validate_upload

# Bid amount is a DecimalField(max_digits=14, decimal_places=2) — keep the
# manual check in the `bid` action in sync with that column limit so an
# oversized amount is rejected cleanly instead of failing at the DB.
MAX_BID_AMOUNT = Decimal("999999999999.99")

# Application-level caps for free-text bid fields that are written straight
# from request.data (bypassing the serializer, so the model's max_length
# is never enforced by Django itself — see the `bid` action below).
BID_TEXT_FIELD_LIMITS = {
    "delivery_timeline": 100,
    "notes": 4000,
    "additional_comments": 4000,
    "brand_name": 255,
    "model_number": 255,
    "warranty_period": 100,
}


def close_expired_published_projects():
    """Flip any PUBLISHED procurement whose bid deadline has passed to CLOSED.

    There's no separate worker/scheduler in this deployment, so this runs
    lazily on read instead of via cron: called from every entry point that
    lists projects, so the transition happens within one request of the
    deadline passing rather than needing an external trigger."""
    Project.objects.filter(
        status=Project.Status.PUBLISHED, deadline__lt=timezone.localdate(),
    ).update(status=Project.Status.CLOSED)


class PublicProcurementView(APIView):
    """Unauthenticated public window into the procurement process.

    Anyone — no account, no login — can see the procurements currently open for
    bidding and the contracts that have already been awarded. This powers the
    public "Public Results" page; bidding itself still requires a verified
    supplier account, so the page only exposes read-only summary data (never
    documents, bid amounts, or supplier contact details)."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def get(self, request):
        close_expired_published_projects()
        published = (
            Project.objects.filter(status=Project.Status.PUBLISHED)
            .annotate(num_bids=Count("bids"))
            .order_by("deadline", "-created_at")
        )
        biddings = [
            {
                "code": p.code,
                "name": p.name,
                "category": p.category,
                "type": p.type,
                "budget": str(p.budget),
                "deadline": p.deadline,
                "delivery_location": p.delivery_location,
                "bids": p.num_bids,
            }
            for p in published
        ]

        awards = (
            Award.objects.select_related("project", "supplier")
            .filter(status=Award.Status.WON)
            .order_by("-awarded_at")
        )
        winners = [
            {
                "code": a.project.code,
                "name": a.project.name,
                "category": a.project.category,
                "winner": a.supplier.company,
                "awarded_at": a.awarded_at,
            }
            for a in awards
        ]

        return Response({"biddings": biddings, "winners": winners})


class ProjectViewSet(viewsets.ModelViewSet):
    queryset = Project.objects.all()
    serializer_class = ProjectSerializer
    # Creating a procurement uploads the required documents (multipart); reads
    # and the approve/reject actions use JSON.
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_permissions(self):
        # Head approves/rejects/requests-revision; suppliers bid; Admin creates,
        # manages & resubmits flagged documents; everyone signed in can read
        # (suppliers see only eligible projects — get_queryset).
        if self.action in {"approve", "reject", "request_revision"}:
            return [IsHeadRole()]
        if self.action == "bid":
            return [IsSupplierRole()]
        if self.action in {"list", "retrieve", "stats"}:
            return [permissions.IsAuthenticated()]
        return [IsAdminRole()]

    def get_queryset(self):
        close_expired_published_projects()
        # Annotate the bid count in one query instead of a COUNT per project.
        qs = Project.objects.annotate(num_bids=Count("bids"))
        # Suppliers only ever see PUBLISHED procurements whose category matches
        # one of the categories they registered for (eligibility = category match).
        if getattr(self.request.user, "role", None) == "supplier":
            supplier = Supplier.objects.filter(user=self.request.user).first()
            categories = (supplier.business_types if supplier else []) or ["__no_match__"]
            qs = qs.filter(status=Project.Status.PUBLISHED, category__in=categories)
        return qs

    @action(detail=True, methods=["post"])
    def bid(self, request, pk=None):
        """A verified, category-matching supplier submits (or updates) a bid on a
        published procurement, with full documents + declarations (multipart).
        Eligibility is enforced here and by get_queryset."""
        project = self.get_object()  # 404 already filters to eligible published projects
        supplier = Supplier.objects.filter(user=request.user).first()
        if supplier is None:
            return Response({"detail": "No supplier profile found."}, status=http_status.HTTP_404_NOT_FOUND)
        if supplier.qualification_status != Supplier.Qualification.VERIFIED:
            return Response(
                {"detail": "Your account must be approved before you can submit bids."},
                status=http_status.HTTP_403_FORBIDDEN,
            )
        if project.status != Project.Status.PUBLISHED:
            return Response({"detail": "This procurement is not open for bidding."},
                            status=http_status.HTTP_400_BAD_REQUEST)
        if project.deadline and timezone.localdate() > project.deadline:
            return Response({"detail": "The bid submission deadline for this procurement has passed."},
                            status=http_status.HTTP_400_BAD_REQUEST)

        data = request.data

        # ── Required information ──────────────────────────────────────────────
        try:
            amount = Decimal(str(data.get("amount")))
            if amount <= 0 or amount > MAX_BID_AMOUNT:
                raise ValueError
        except (TypeError, ValueError, InvalidOperation, ArithmeticError):
            return Response(
                {"detail": f"Please enter a valid bid amount greater than zero and no more than {MAX_BID_AMOUNT}."},
                status=http_status.HTTP_400_BAD_REQUEST)

        delivery_timeline = (data.get("delivery_timeline") or "").strip()
        if not delivery_timeline:
            return Response({"detail": "Please specify your delivery timeline."},
                            status=http_status.HTTP_400_BAD_REQUEST)

        notes = (data.get("notes") or "").strip()
        if len(notes) < 20:
            return Response({"detail": "Please provide a more detailed proposal of at least 20 characters."},
                            status=http_status.HTTP_400_BAD_REQUEST)

        additional_comments = (data.get("additional_comments") or "").strip()
        brand_name = (data.get("brand_name") or "").strip()
        model_number = (data.get("model_number") or "").strip()
        warranty_period = (data.get("warranty_period") or "").strip()

        # Reject anything malformed/oversized up front — these fields are written
        # straight to the model below, bypassing the serializer (and therefore
        # the model's own max_length enforcement), so check it explicitly here.
        for field_name, value in (
            ("delivery_timeline", delivery_timeline), ("notes", notes),
            ("additional_comments", additional_comments), ("brand_name", brand_name),
            ("model_number", model_number), ("warranty_period", warranty_period),
        ):
            limit = BID_TEXT_FIELD_LIMITS[field_name]
            if len(value) > limit:
                return Response({field_name: f"Must be {limit} characters or fewer."},
                                status=http_status.HTTP_400_BAD_REQUEST)

        # ── Declarations (all four are mandatory under RA 9184) ───────────────
        def _truthy(value):
            return str(value).strip().lower() in {"true", "1", "yes", "on"}

        terms_accepted = _truthy(data.get("terms_accepted"))
        interest_declared = _truthy(data.get("interest_declared"))
        scm_declared = _truthy(data.get("scm_declared"))
        accuracy_confirmed = _truthy(data.get("accuracy_confirmed"))
        if not all([terms_accepted, interest_declared, scm_declared, accuracy_confirmed]):
            return Response(
                {"detail": "All declarations are required before submitting your bid."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        # Specification confirmation only applies when the project has a reference image.
        specification_confirmed = _truthy(data.get("specification_confirmed"))
        if project.reference_image and not specification_confirmed:
            return Response(
                {"detail": "Please confirm your product matches the required specification."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        # ── Quotation document is required ────────────────────────────────────
        quotation = request.FILES.get("quotation_document")
        existing = Bid.objects.filter(project=project, supplier=supplier).first()
        if quotation is None and (existing is None or not existing.quotation_document):
            return Response({"detail": "Please upload your quotation document."},
                            status=http_status.HTTP_400_BAD_REQUEST)

        # Validate every uploaded file (type + size) BEFORE touching the DB.
        # This view writes files straight onto the model via setattr()/save(),
        # which never calls full_clean() — so the model field's `validators=`
        # (validate_bid_upload) would otherwise silently never run, letting an
        # oversized or wrong-type file reach disk unchecked.
        bid_file_fields = (
            "quotation_document", "technical_document", "supplier_product_image",
            "supplier_datasheet", "supplier_compliance_doc",
        )
        for field in bid_file_fields:
            uploaded = request.FILES.get(field)
            if uploaded is not None:
                try:
                    validate_bid_upload(uploaded)
                except DjangoValidationError as exc:
                    return Response({field: exc.messages}, status=http_status.HTTP_400_BAD_REQUEST)

        other_attachments = request.FILES.getlist("other_attachments")
        for uploaded in other_attachments:
            try:
                validate_bid_upload(uploaded)
            except DjangoValidationError as exc:
                return Response({"other_attachments": exc.messages}, status=http_status.HTTP_400_BAD_REQUEST)

        bid, created = Bid.objects.get_or_create(
            project=project, supplier=supplier, defaults={"amount": amount},
        )

        bid.amount = amount
        bid.notes = notes
        bid.delivery_timeline = delivery_timeline
        bid.additional_comments = additional_comments
        bid.brand_name = brand_name or None
        bid.model_number = model_number or None
        bid.warranty_period = warranty_period or None
        bid.terms_accepted = terms_accepted
        bid.interest_declared = interest_declared
        bid.scm_declared = scm_declared
        bid.accuracy_confirmed = accuracy_confirmed
        bid.specification_confirmed = specification_confirmed
        bid.status = Bid.Status.UNDER_REVIEW

        # Replace any uploaded file only when a new one is provided (so re-submitting
        # without re-attaching keeps the previously uploaded document). Already
        # validated above, so this is just the assignment.
        for field in bid_file_fields:
            uploaded = request.FILES.get(field)
            if uploaded is not None:
                setattr(bid, field, uploaded)
        bid.save()

        # Multiple "Other Attachments" — each becomes its own row.
        for uploaded in other_attachments:
            BidAttachment.objects.create(bid=bid, file=uploaded, file_name=uploaded.name)

        verb = "submitted a bid on" if created else "updated their bid on"
        notify_admins(
            f"{supplier.company} {verb} \"{project.name}\" ({project.code}).",
            link="/admin/bids",
        )
        return Response(
            BidSerializer(bid, context={"request": request}).data,
            status=http_status.HTTP_201_CREATED,
        )

    def perform_create(self, serializer):
        # Auto-generate a code like P-2026-001
        year = date.today().year
        count = Project.objects.filter(code__startswith=f"P-{year}-").count() + 1
        code = f"P-{year}-{count:03d}"
        user = self.request.user if self.request.user.is_authenticated else None
        # Created from Planning → goes straight into the Head's approval queue.
        project = serializer.save(code=code, created_by=user, status=Project.Status.PENDING_HEAD)
        notify_heads(
            f"New procurement \"{project.name}\" ({project.code}) needs your approval.",
            link="/head/pending",
        )

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        """Head approves a pending project — it then appears on the Admin Projects page."""
        project = self.get_object()
        project.status = Project.Status.APPROVED
        project.reject_reason = ""
        project.reviewed_at = timezone.now()
        project.save()
        notify_users(
            [project.created_by],
            f"Your procurement \"{project.name}\" ({project.code}) was approved by the Head.",
            link="/admin/projects",
        )
        return Response(self.get_serializer(project).data)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        """Head rejects a pending project, with an optional reason for the Admin."""
        project = self.get_object()
        project.status = Project.Status.REJECTED
        project.reject_reason = request.data.get("reason", "") or ""
        project.reviewed_at = timezone.now()
        project.save()
        reason = project.reject_reason.strip()
        notify_users(
            [project.created_by],
            f"Your procurement \"{project.name}\" ({project.code}) was rejected by the Head."
            + (f" Reason: {reason}" if reason else ""),
            link="/admin/projects",
        )
        return Response(self.get_serializer(project).data)

    @action(detail=True, methods=["post"], url_path="request-revision")
    def request_revision(self, request, pk=None):
        """Head flags one or more procurement documents as needing a fix,
        instead of an outright reject. The project leaves the Head's Pending
        Approval queue and goes back to the Admin's Planning page; once the
        Admin re-uploads the flagged file(s) via resubmit-documents, it
        automatically returns to pending_head for a fresh look."""
        project = self.get_object()
        documents = request.data.get("documents") or {}
        if not isinstance(documents, dict) or not documents:
            return Response(
                {"detail": "Flag at least one document for revision."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        for key in documents:
            if key not in PROCUREMENT_DOCUMENT_KEYS:
                return Response({"detail": f"Unknown document '{key}'."}, status=http_status.HTTP_400_BAD_REQUEST)

        # Same approach as Supplier/Bid request_revision: flagged -> needs_revision
        # (with the Head's note), every other uploaded document -> approved.
        reviews = dict(project.document_reviews or {})
        for key in PROCUREMENT_DOCUMENT_KEYS:
            if key in documents:
                reviews[key] = {"status": "needs_revision", "note": documents[key] or ""}
            elif getattr(project, key, None):
                reviews[key] = {"status": "approved", "note": ""}
            else:
                reviews.pop(key, None)

        project.document_reviews = reviews
        project.status = Project.Status.NEEDS_REVISION
        project.reviewed_at = timezone.now()
        project.save()

        flagged = ", ".join(label for key, label, _ in PROCUREMENT_DOCUMENT_FIELDS if key in documents)
        notify_users(
            [project.created_by],
            f"The Head requested a revision on \"{project.name}\" ({project.code}): {flagged}. "
            "Please re-upload the flagged document(s).",
            link="/admin/planning",
        )
        return Response(self.get_serializer(project).data)

    @action(detail=True, methods=["post"], url_path="resubmit-documents")
    def resubmit_documents(self, request, pk=None):
        """Admin re-uploads just the document(s) the Head flagged. The project
        automatically returns to pending_head so the Head sees it again."""
        project = self.get_object()
        if project.status != Project.Status.NEEDS_REVISION:
            return Response(
                {"detail": "This procurement is not awaiting a document revision."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        for key in PROCUREMENT_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded is not None:
                try:
                    validate_upload(uploaded)
                except DjangoValidationError as exc:
                    return Response({key: exc.messages}, status=http_status.HTTP_400_BAD_REQUEST)

        reviews = dict(project.document_reviews or {})
        updated = []
        for key in PROCUREMENT_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded:
                setattr(project, key, uploaded)
                prev_note = (reviews.get(key) or {}).get("note", "")
                reviews[key] = {"status": "resubmitted", "note": prev_note}
                updated.append(key)

        if not updated:
            return Response(
                {"detail": "Upload at least one document to resubmit."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        project.document_reviews = reviews
        project.status = Project.Status.PENDING_HEAD
        project.save()

        notify_heads(
            f"\"{project.name}\" ({project.code}) re-submitted {len(updated)} document(s) for review.",
            link="/head/pending",
        )
        return Response(self.get_serializer(project).data)

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None):
        """Open the procurement for bidding. The deadline is computed HERE, now,
        from the stored bidding period — never chosen ahead of time — so the
        bidding window is always real no matter how long this project sat
        waiting in approval (see Project.bidding_period_days)."""
        project = self.get_object()
        if project.bidding_period_days:
            project.deadline = timezone.localdate() + timedelta(days=project.bidding_period_days)
        project.status = Project.Status.PUBLISHED
        project.published_at = timezone.now()
        project.save()
        # Notify verified suppliers whose categories match — the ones who can bid.
        # Filtered in Python (mirrors get_queryset) to avoid JSONField lookup quirks.
        if project.category:
            verified = Supplier.objects.select_related("user").filter(
                qualification_status=Supplier.Qualification.VERIFIED,
            )
            recipients = [
                s.user for s in verified if project.category in (s.business_types or [])
            ]
            notify_users(
                recipients,
                f"New procurement open for bidding: \"{project.name}\" ({project.code}).",
                link="/supplier/projects",
            )
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

    @action(detail=False, methods=["get", "patch"])
    def me(self, request):
        supplier = self._own_supplier(request)
        if supplier is None:
            return Response({"detail": "No supplier profile found."}, status=http_status.HTTP_404_NOT_FOUND)

        if request.method == "PATCH":
            full_name = request.data.get("full_name")
            if full_name is not None and supplier.user_id:
                supplier.user.full_name = full_name
                supplier.user.save(update_fields=["full_name"])
            serializer = SupplierMeUpdateSerializer(supplier, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save()

        return self._detail_response(supplier)

    @action(detail=False, methods=["post"])
    def resubmit(self, request):
        """Supplier re-uploads documents the admin flagged, then re-enters the queue.

        Each re-uploaded document is marked 'resubmitted' (not just cleared) so the
        admin can tell at a glance which file is new and needs a fresh look, while
        the documents that were already accepted stay marked 'approved'.
        """
        supplier = self._own_supplier(request)
        if supplier is None:
            return Response({"detail": "No supplier profile found."}, status=http_status.HTTP_404_NOT_FOUND)

        # Validate every re-uploaded file (type + size) BEFORE touching the DB —
        # same reasoning as ProjectViewSet.bid(): setattr()/save() never calls
        # full_clean(), so the model field's validate_upload would otherwise
        # never run on this path.
        for key in SUPPLIER_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded:
                try:
                    validate_upload(uploaded)
                except DjangoValidationError as exc:
                    return Response({key: exc.messages}, status=http_status.HTTP_400_BAD_REQUEST)

        reviews = dict(supplier.document_reviews or {})
        updated = []
        for key in SUPPLIER_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded:
                setattr(supplier, key, uploaded)
                prev_note = (reviews.get(key) or {}).get("note", "")
                # Mark as resubmitted (carry the original note for context) instead
                # of removing it, so the admin sees exactly what changed.
                reviews[key] = {"status": "resubmitted", "note": prev_note}
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

        # Tell the admins this supplier re-submitted so it returns to their queue.
        notify_admins(
            f"{supplier.company} re-submitted {len(updated)} document(s) for review.",
            link="/admin/suppliers",
        )
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
        notify_supplier(
            supplier,
            "Your supplier account has been verified. You can now submit bids.",
            link="/supplier/projects",
            email_subject="Your E-Procurement supplier account has been verified",
        )
        return self._detail_response(supplier)

    @action(detail=True, methods=["post"])
    def reject(self, request, pk=None):
        supplier = self.get_object()
        supplier.qualification_status = Supplier.Qualification.REJECTED
        supplier.admin_notes = request.data.get("note", "")
        supplier.reviewed_at = timezone.now()
        supplier.save()
        reason = (supplier.admin_notes or "").strip()
        notify_supplier(
            supplier,
            "Your supplier registration was rejected." + (f" Reason: {reason}" if reason else ""),
            link="/supplier/profile",
            email_subject="Your E-Procurement supplier registration was rejected",
        )
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

        # Start from the existing review state so we don't lose context, then:
        #  - flagged documents     -> needs_revision (with the admin's note)
        #  - every other uploaded  -> approved (so the supplier/admin can see the
        #                             rest were accepted and only fix what's flagged)
        reviews = dict(supplier.document_reviews or {})
        for key in documents:
            if key not in SUPPLIER_DOCUMENT_KEYS:
                return Response(
                    {"detail": f"Unknown document '{key}'."},
                    status=http_status.HTTP_400_BAD_REQUEST,
                )
        for key in SUPPLIER_DOCUMENT_KEYS:
            if key in documents:
                reviews[key] = {"status": "needs_revision", "note": documents[key] or ""}
            elif getattr(supplier, key, None):
                reviews[key] = {"status": "approved", "note": ""}
            else:
                reviews.pop(key, None)

        supplier.document_reviews = reviews
        supplier.qualification_status = Supplier.Qualification.NEEDS_REVISION
        supplier.admin_notes = request.data.get("note", "")
        supplier.reviewed_at = timezone.now()
        supplier.save()

        flagged = ", ".join(
            label for key, label, _ in SUPPLIER_DOCUMENT_FIELDS if key in documents
        )
        notify_supplier(
            supplier,
            f"Revision requested on: {flagged}. Please re-upload the flagged document(s).",
            link="/supplier/profile",
            email_subject="Action needed on your E-Procurement supplier documents",
        )
        return self._detail_response(supplier)


class BidViewSet(viewsets.ModelViewSet):
    queryset = Bid.objects.select_related("project", "supplier").all()
    serializer_class = BidSerializer

    def get_permissions(self):
        # Suppliers list/withdraw their OWN bids (scoped by get_queryset) and
        # resubmit flagged documents; Admin lists all + runs evaluation actions.
        if self.action == "resubmit_documents":
            return [IsSupplierRole()]
        if self.action in {"list", "retrieve", "destroy"}:
            return [permissions.IsAuthenticated()]
        return [IsAdminRole()]

    def get_queryset(self):
        qs = Bid.objects.select_related(
            "project", "supplier", "supplier__user").prefetch_related("attachments")
        role = getattr(self.request.user, "role", None)
        if role == "supplier":
            qs = qs.filter(supplier__user=self.request.user)
        elif role != "admin":
            return qs.none()
        # Admin can scope to one project's bids for the evaluation screen.
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    def _set_status(self, bid, status):
        bid.status = status
        bid.reviewed_at = timezone.now()
        bid.save(update_fields=["status", "reviewed_at"])
        return Response(self.get_serializer(bid).data)

    @action(detail=True, methods=["post"])
    def qualify(self, request, pk=None):
        """Mark a bid Qualified (passed the evaluation criteria)."""
        bid = self.get_object()
        notify_supplier(
            bid.supplier,
            f"Your bid on \"{bid.project.name}\" ({bid.project.code}) qualified for evaluation.",
            link="/supplier/bids",
            email_subject=f"Your bid on {bid.project.code} qualified for evaluation",
        )
        return self._set_status(bid, Bid.Status.QUALIFIED)

    @action(detail=True, methods=["post"])
    def disqualify(self, request, pk=None):
        """Mark a bid Disqualified."""
        bid = self.get_object()
        notify_supplier(
            bid.supplier,
            f"Your bid on \"{bid.project.name}\" ({bid.project.code}) was disqualified.",
            link="/supplier/bids",
            email_subject=f"Your bid on {bid.project.code} was disqualified",
        )
        return self._set_status(bid, Bid.Status.DISQUALIFIED)

    @action(detail=True, methods=["post"], url_path="request-revision")
    def request_revision(self, request, pk=None):
        """Admin flags one or more documents on this bid as needing a fix.

        This does NOT disqualify the bid — the supplier stays in the running
        and just re-uploads the flagged file(s) via resubmit-documents. The
        only hard gate is select-winner, which is blocked while any document
        here is still 'needs_revision'."""
        bid = self.get_object()
        documents = request.data.get("documents") or {}
        if not isinstance(documents, dict) or not documents:
            return Response(
                {"detail": "Flag at least one document for revision."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        for key in documents:
            if key not in BID_DOCUMENT_KEYS:
                return Response({"detail": f"Unknown document '{key}'."}, status=http_status.HTTP_400_BAD_REQUEST)

        # Same approach as Supplier.request_revision: flagged -> needs_revision
        # (with the admin's note), every other uploaded document -> approved.
        reviews = dict(bid.document_reviews or {})
        for key in BID_DOCUMENT_KEYS:
            if key in documents:
                reviews[key] = {"status": "needs_revision", "note": documents[key] or ""}
            elif getattr(bid, key, None):
                reviews[key] = {"status": "approved", "note": ""}
            else:
                reviews.pop(key, None)

        bid.document_reviews = reviews
        bid.save(update_fields=["document_reviews"])

        flagged = ", ".join(label for key, label, _ in BID_DOCUMENT_FIELDS if key in documents)
        notify_supplier(
            bid.supplier,
            f"Document revision requested on your bid for \"{bid.project.name}\" ({bid.project.code}): "
            f"{flagged}. You're still in this bidding — please re-upload the flagged document(s).",
            link="/supplier/bids",
            email_subject=f"Action needed on your bid documents for {bid.project.code}",
        )
        return Response(self.get_serializer(bid).data)

    @action(detail=True, methods=["post"], url_path="resubmit-documents")
    def resubmit_documents(self, request, pk=None):
        """Supplier re-uploads just the document(s) the Admin flagged on their
        own bid (ownership is enforced by get_queryset scoping suppliers to
        their own bids — get_object() 404s on any other supplier's bid)."""
        bid = self.get_object()
        if bid.project.status == Project.Status.AWARDED:
            return Response(
                {"detail": "This procurement has already been awarded."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        # Validate every re-uploaded file BEFORE touching the DB — setattr()/
        # save() never calls full_clean(), so validate_bid_upload would
        # otherwise never run on this path (same reasoning as ProjectViewSet.bid).
        for key in BID_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded is not None:
                try:
                    validate_bid_upload(uploaded)
                except DjangoValidationError as exc:
                    return Response({key: exc.messages}, status=http_status.HTTP_400_BAD_REQUEST)

        reviews = dict(bid.document_reviews or {})
        updated = []
        for key in BID_DOCUMENT_KEYS:
            uploaded = request.FILES.get(key)
            if uploaded:
                setattr(bid, key, uploaded)
                prev_note = (reviews.get(key) or {}).get("note", "")
                reviews[key] = {"status": "resubmitted", "note": prev_note}
                updated.append(key)

        if not updated:
            return Response(
                {"detail": "Upload at least one document to resubmit."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        bid.document_reviews = reviews
        bid.save()

        notify_admins(
            f"{bid.supplier.company} re-submitted {len(updated)} document(s) on their bid for "
            f"\"{bid.project.name}\" ({bid.project.code}).",
            link=f"/admin/bids/{bid.project_id}",
        )
        return Response(self.get_serializer(bid).data)

    @action(detail=True, methods=["post"], url_path="select-winner")
    def select_winner(self, request, pk=None):
        """Select this bid as the winner: records the Award, marks the project
        Awarded, and notifies the participating suppliers."""
        bid = self.get_object()
        project = bid.project

        flagged_keys = [
            key for key, review in (bid.document_reviews or {}).items()
            if (review or {}).get("status") == "needs_revision"
        ]
        if flagged_keys:
            labels = ", ".join(label for key, label, _ in BID_DOCUMENT_FIELDS if key in flagged_keys)
            return Response(
                {"detail": f"This bid still has document(s) flagged for revision and can't be "
                           f"selected as the winner until they're fixed: {labels}."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        bid.status = Bid.Status.WINNER
        bid.save(update_fields=["status"])

        Award.objects.get_or_create(
            project=project, supplier=bid.supplier,
            defaults={"bid": bid, "amount": bid.amount},
        )
        project.status = Project.Status.AWARDED
        project.awarded_at = timezone.now()
        update_fields = ["status", "awarded_at"]
        # Expected delivery is computed HERE, at award — not chosen ahead of
        # time — so the promise is always real no matter how long evaluation
        # took (standard procurement practice counts delivery from Notice to
        # Proceed, i.e. after a winner is chosen, not from bid close).
        if project.delivery_period_days:
            project.expected_delivery_date = timezone.localdate() + timedelta(days=project.delivery_period_days)
            update_fields.append("expected_delivery_date")
        project.save(update_fields=update_fields)

        # Notify the winner and the other bidders (skip suppliers with no account).
        for other in project.bids.select_related("supplier__user"):
            user = getattr(other.supplier, "user", None)
            if not user:
                continue
            if other.id == bid.id:
                msg = f"Congratulations! Your bid won \"{project.name}\" ({project.code})."
                subject = f"You won the contract for {project.code}"
            else:
                msg = f"\"{project.name}\" ({project.code}) has been awarded to another supplier."
                subject = f"Bid result for {project.code}"
            Notification.objects.create(user=user, message=msg, link="/supplier/bids")
            email_user(user, subject, msg)

        return Response(self.get_serializer(bid).data)


class AwardViewSet(viewsets.ModelViewSet):
    """Admin-only: contract amounts and award records. Awards are normally
    created by BidViewSet.select_winner — this CRUD API exists for the Admin
    Awards/Reports pages, never for suppliers (a supplier could otherwise
    award themselves a project or read every other supplier's contract value)."""

    queryset = Award.objects.select_related("project", "supplier").all()
    serializer_class = AwardSerializer
    permission_classes = [IsAdminRole]


class DocumentViewSet(viewsets.ModelViewSet):
    """Admin-only: supplier compliance documents (expiry tracking)."""

    queryset = Document.objects.select_related("supplier").all()
    serializer_class = DocumentSerializer
    permission_classes = [IsAdminRole]


class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    """A user's own in-app notifications + a bulk 'mark read' action."""

    serializer_class = NotificationSerializer

    def get_queryset(self):
        return Notification.objects.filter(user=self.request.user)

    @action(detail=False, methods=["post"], url_path="mark-read")
    def mark_read(self, request):
        self.get_queryset().filter(is_read=False).update(is_read=True)
        return Response({"detail": "All notifications marked as read."})
