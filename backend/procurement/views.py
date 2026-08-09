import logging
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.db.models import Count
from django.utils import timezone
from rest_framework import status as http_status
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.audit import log_action

from .blockchain import (
    ETHERSCAN_TX_URL,
    LEDGER_CONTRACT_ADDRESS,
    SEPOLIA_CHAIN_ID,
    anchor_award,
    anchor_bid,
    anchor_project,
    anchor_summary,
    attach_anchors,
    attach_transaction,
    verify_anchor,
)
from .documents import DOCUMENT_BUILDERS
from .models import (
    AWARD_DOCUMENT_FIELDS,
    AWARD_DOCUMENT_ISSUED_FIELDS,
    AWARD_DOCUMENT_KEYS,
    AWARD_DOCUMENT_STAGES,
    BID_DOCUMENT_FIELDS,
    BID_DOCUMENT_KEYS,
    PROCUREMENT_DOCUMENT_FIELDS,
    PROCUREMENT_DOCUMENT_KEYS,
    SUPPLIER_DOCUMENT_FIELDS,
    SUPPLIER_DOCUMENT_KEYS,
    Award,
    Bid,
    BidAttachment,
    BlockchainAnchor,
    Document,
    Notification,
    Project,
    Supplier,
)
from rest_framework import permissions

from .notifications import email_user, notify_admins, notify_heads, notify_supplier, notify_users
from .permissions import IsAdminOrHeadRole, IsAdminRole, IsHeadRole, IsSupplierRole
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

logger = logging.getLogger(__name__)

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


def next_project_code():
    """The next free procurement code for this year, e.g. "P-2026-004".

    Derived from the HIGHEST existing code, not from a row count. Counting was
    wrong in two ways that both ended in an IntegrityError on the unique `code`
    column — and once a year's numbering collided, no procurement could be
    created for the rest of that year:

      * deleting a project lowered the count, so the next create re-proposed a
        code that still existed (delete P-2026-002 of three, count+1 == 3, and
        P-2026-003 is already taken);
      * two simultaneous creates read the same count and proposed the same code.

    The retry loop closes the concurrency window that remains between reading
    the maximum and committing the insert: if another request wins the race, the
    unique constraint rejects this one and we simply take the next number. The
    caller must therefore be prepared to have `code` re-derived, which is why
    this is called inside perform_create's save.
    """
    year = date.today().year
    prefix = f"P-{year}-"
    latest = (
        Project.objects.filter(code__startswith=prefix)
        .order_by("-code")
        .values_list("code", flat=True)
        .first()
    )
    try:
        # "P-2026-014" -> 14. A malformed legacy code falls back to the count.
        nxt = int(latest.rsplit("-", 1)[1]) + 1 if latest else 1
    except (ValueError, IndexError):
        nxt = Project.objects.filter(code__startswith=prefix).count() + 1
    return f"{prefix}{nxt:03d}"


def close_expired_published_projects():
    """Flip any PUBLISHED procurement whose bid deadline has passed to CLOSED.

    There's no separate worker/scheduler in this deployment, so this runs
    lazily on read instead of via cron: called from every entry point that
    lists projects, so the transition happens within one request of the
    deadline passing rather than needing an external trigger."""
    Project.objects.filter(
        status=Project.Status.PUBLISHED, deadline__lt=timezone.localdate(),
    ).update(status=Project.Status.CLOSED)


def anchored_response(serializer_data, anchor, status_code=http_status.HTTP_200_OK):
    """Return a transition's normal response body with the freshly computed
    `anchor` (data_hash + where to post the tx hash back) added.

    This is how the frontend learns what to sign: the DB change has already
    happened and is final, and `anchor` is the optional blockchain follow-up.
    `anchor` is null when anchoring is disabled or failed — the caller just skips
    the on-chain step and the record shows as "not yet anchored"."""
    data = dict(serializer_data)
    data["anchor"] = anchor_summary(anchor)
    return Response(data, status=status_code)


def attach_anchor_transaction(request, *, entity_ref, entity_type, entity_id):
    """Shared body of the three /anchor/ endpoints.

    Accepts { anchor_id?, stage?, tx_hash, block_number?, actor_address? } and
    records the confirmed transaction on the matching anchor. `anchor_id` (which
    the transition response hands the frontend) is the precise path; `stage` is
    the fallback so a retry can find the newest un-anchored anchor for a stage.

    Idempotent: posting a tx hash for an already-anchored row is a no-op 200, so
    a double-click or a retry after a flaky response can't corrupt the trail."""
    scoped = BlockchainAnchor.objects.filter(
        entity_ref=entity_ref, entity_type=entity_type, entity_id=str(entity_id),
    )

    anchor_id = request.data.get("anchor_id")
    stage = (request.data.get("stage") or "").strip()
    if anchor_id:
        # Coerced explicitly: passing a non-numeric anchor_id straight into
        # filter(id=...) makes Django raise ValueError, which DRF turns into a
        # 500 rather than the 400 that a malformed request deserves.
        try:
            anchor_id = int(anchor_id)
        except (TypeError, ValueError):
            return Response(
                {"detail": "anchor_id must be a number."},
                status=http_status.HTTP_400_BAD_REQUEST)
        anchor = scoped.filter(id=anchor_id).first()
    elif stage:
        anchor = scoped.filter(stage=stage, tx_hash="").order_by("-created_at", "-id").first()
    else:
        return Response(
            {"detail": "Provide anchor_id or stage."}, status=http_status.HTTP_400_BAD_REQUEST)

    if anchor is None:
        return Response(
            {"detail": "No matching blockchain anchor for this record."},
            status=http_status.HTTP_404_NOT_FOUND)

    if anchor.anchored:
        return Response(anchor_summary(anchor))

    try:
        attach_transaction(
            anchor,
            request.data.get("tx_hash"),
            request.data.get("block_number"),
            actor_address=request.data.get("actor_address", ""),
        )
    except ValueError as exc:
        return Response({"detail": str(exc)}, status=http_status.HTTP_400_BAD_REQUEST)

    log_action(
        request, "blockchain.anchored",
        entity_type=anchor.entity_type, entity_id=anchor.entity_id,
        description=f"Anchored {anchor.entity_ref} {anchor.stage} on-chain (tx {anchor.tx_hash}).",
    )
    return Response(anchor_summary(anchor))


class PublicAnchorTrailView(APIView):
    """Unauthenticated blockchain trail for one procurement code.

    Anyone can verify a procurement without an account, a wallet, or gas: this
    returns the hashes the system recorded at each lifecycle step plus the
    Sepolia transaction that witnesses each one. The public verification page
    cross-checks these against the contract itself, so a hash silently edited in
    this database would no longer match the chain.

    Deliberately hash-only: no payloads, no bid amounts, no supplier identities —
    same privacy posture as PublicProcurementView. `document_hash` is included so
    a citizen holding a copy of a published document can hash their file and
    prove it is the one that was attested to."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def get(self, request, code):
        project = Project.objects.filter(code=code).first()
        if project is None:
            return Response({"detail": "Unknown procurement code."},
                            status=http_status.HTTP_404_NOT_FOUND)

        # ?deep=1 additionally re-reads every anchored document and re-hashes it.
        # Off by default: that's one storage read per anchor, too slow to run on
        # every page load, and the cheap record check already catches an edited
        # amount, status or date.
        deep = request.query_params.get("deep") in {"1", "true", "yes"}

        anchors = BlockchainAnchor.objects.filter(entity_ref=code)
        integrity = {a.id: verify_anchor(a, deep=deep) for a in anchors}
        trail = [
            {
                "entity_type": a.entity_type,
                "stage": a.stage,
                "stage_label": a.get_stage_display(),
                "data_hash": a.data_hash,
                # Published to let a citizen hash a document they hold and prove
                # it is the one attested to — but only for documents that are
                # actually public. A losing bidder's quotation is not, so its
                # hash is withheld (the AWARD anchor covers the winning bid,
                # which a procurement award does make disclosable).
                "document_hash": "" if a.entity_type == BlockchainAnchor.EntityType.BID else a.document_hash,
                "tx_hash": a.tx_hash,
                "block_number": a.block_number,
                "actor_address": a.actor_address,
                "anchored": a.anchored,
                "explorer_url": (ETHERSCAN_TX_URL + a.tx_hash) if a.tx_hash else "",
                "recorded_at": a.created_at,
                "anchored_at": a.anchored_at,
                # Does the record STILL hash to what was published? Comparing the
                # stored hash with the chain only proves the anchor row is
                # intact; this proves the data behind it is.
                "integrity": integrity[a.id],
            }
            for a in anchors
        ]
        altered = [t for t in trail if t["integrity"]["status"] == "mismatch"]
        return Response({
            "code": project.code,
            "name": project.name,
            "status": project.status,
            "category": project.category,
            "contract_address": LEDGER_CONTRACT_ADDRESS,
            "chain": "sepolia",
            "chain_id": SEPOLIA_CHAIN_ID,
            "deep_checked": deep,
            "altered_count": len(altered),
            "anchors": trail,
        })


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
        if self.action in {"list", "retrieve", "stats", "anchors"}:
            return [permissions.IsAuthenticated()]
        # Both Admin and Head cause project transitions, so both may attach the
        # resulting transaction hash.
        if self.action == "anchor":
            return [IsAdminOrHeadRole()]
        return [IsAdminRole()]

    # Once bidding opens, the procurement's terms are fixed. Suppliers priced
    # their bids against this budget, these specifications and this evaluation
    # criteria, and every one of those fields is inside the BIDDING_OPEN hash
    # that went on-chain. Editing afterwards silently rewrites the deal AND
    # makes verify_anchor report the procurement as altered on the public page
    # — so an innocent typo fix permanently brands an honest record as tampered.
    LOCKED_STATUSES = {
        Project.Status.PUBLISHED, Project.Status.AWARDED, Project.Status.CLOSED,
    }

    def update(self, request, *args, **kwargs):
        project = self.get_object()
        if project.status in self.LOCKED_STATUSES:
            return Response(
                {"detail": f"\"{project.name}\" is already {project.get_status_display().lower()} "
                           "and can no longer be edited. Its details are part of the published "
                           "record suppliers bid against."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        """Delete a procurement — only before it has been opened for bidding.

        A published or awarded procurement has bids, possibly an award, and an
        on-chain trail hanging off it. Deleting the row cascades those away and
        leaves the anchors pointing at nothing, which the public verifier can
        only report as "the record this anchor was taken from no longer exists".
        """
        project = self.get_object()
        if project.status in self.LOCKED_STATUSES:
            return Response(
                {"detail": f"\"{project.name}\" has already been opened for bidding and cannot be "
                           "deleted. Its bids and blockchain record depend on it."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

    def list(self, request, *args, **kwargs):
        """Same as the default list, with every project's blockchain trail
        bulk-loaded in one extra query instead of one query per row."""
        projects = attach_anchors(self.filter_queryset(self.get_queryset()))
        return Response(self.get_serializer(projects, many=True).data)

    @action(detail=True, methods=["post"])
    def anchor(self, request, pk=None):
        """Record the confirmed Sepolia transaction for one of this project's
        anchors: { anchor_id | stage, tx_hash, block_number }.

        Separate from the transition endpoints on purpose — the status change is
        already committed by the time the wallet is even asked to sign, so a
        rejected signature, a wrong network or an empty gas tank leaves a valid
        record that is merely "not yet anchored" and can be retried."""
        project = self.get_object()
        return attach_anchor_transaction(
            request, entity_ref=project.code,
            entity_type=BlockchainAnchor.EntityType.PROJECT, entity_id=project.id,
        )

    @action(detail=True, methods=["get"])
    def anchors(self, request, pk=None):
        """This procurement's full anchor trail (its own, its bids', its award's)
        — powers the blockchain status badge and the "retry anchoring" button."""
        project = self.get_object()
        rows = BlockchainAnchor.objects.filter(entity_ref=project.code)
        include_payload = getattr(request.user, "role", None) == "admin"
        deep = request.query_params.get("deep") in {"1", "true", "yes"}

        anchors = []
        for a in rows:
            data = anchor_summary(a, include_payload=include_payload)
            data["integrity"] = verify_anchor(a, deep=deep)
            anchors.append(data)
        return Response({
            "code": project.code,
            "contract_address": LEDGER_CONTRACT_ADDRESS,
            "chain_id": SEPOLIA_CHAIN_ID,
            "deep_checked": deep,
            "altered_count": sum(1 for a in anchors if a["integrity"]["status"] == "mismatch"),
            "anchors": anchors,
        })

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
        #
        # Re-submitting REPLACES the set rather than adding to it, matching how
        # every other file on a bid behaves and how the form reads ("Other
        # Attachments" shows what will be on file, not what to append). Appending
        # meant a supplier who edited their bid three times ended up with three
        # copies of each attachment for the evaluator to wade through, and the
        # rows grew without bound. Only done when new files were actually
        # attached, so re-submitting without touching this field keeps what is
        # already there — the same rule the single-file fields follow above.
        if other_attachments:
            bid.attachments.all().delete()
            for uploaded in other_attachments:
                BidAttachment.objects.create(bid=bid, file=uploaded, file_name=uploaded.name)

        verb = "submitted a bid on" if created else "updated their bid on"
        notify_admins(
            f"{supplier.company} {verb} \"{project.name}\" ({project.code}).",
            link="/admin/bids",
        )
        log_action(
            request, "bid.submitted" if created else "bid.updated",
            entity_type="Bid", entity_id=bid.id,
            description=f"{supplier.company} {verb} {project.code} for {amount}.",
        )
        # Deliberately NOT anchored here. Only the winning bid reaches the
        # blockchain, and it is anchored at award time (see select_winner) —
        # losing suppliers' amounts stay off the public ledger entirely.
        # The bid is still hashed and stored locally like every other record.
        return anchored_response(
            BidSerializer(bid, context={"request": request}).data,
            None,
            status_code=http_status.HTTP_201_CREATED,
        )

    def create(self, request, *args, **kwargs):
        """Default create, plus the SUBMITTED anchor in the response body so the
        Admin's browser can sign it right after the procurement is filed."""
        response = super().create(request, *args, **kwargs)
        response.data["anchor"] = anchor_summary(getattr(self, "_create_anchor", None))
        return response

    def perform_create(self, serializer):
        user = self.request.user if self.request.user.is_authenticated else None
        # Created from Planning → goes straight into the Head's approval queue.
        # Retried because next_project_code() reads the highest code and another
        # request can insert between that read and this write; the unique
        # constraint is what actually settles the race, so losing it just means
        # taking the next number rather than failing the create.
        for attempt in range(5):
            try:
                with transaction.atomic():
                    project = serializer.save(
                        code=next_project_code(), created_by=user,
                        status=Project.Status.PENDING_HEAD)
                break
            except IntegrityError:
                if attempt == 4:
                    raise
        notify_heads(
            f"New procurement \"{project.name}\" ({project.code}) needs your approval.",
            link="/head/pending",
        )
        log_action(
            self.request, "project.created",
            entity_type="Project", entity_id=project.id,
            description=f"Created procurement {project.code} - {project.name} (sent for approval).",
        )
        # First link in the chain: the procurement as filed, hashed together with
        # its Purchase Request document. Picked up by create() above.
        self._create_anchor = anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)

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
        log_action(
            request, "project.approved",
            entity_type="Project", entity_id=project.id,
            description=f"Head approved procurement {project.code}.",
        )
        anchor = anchor_project(project, BlockchainAnchor.Stage.HEAD_APPROVED)
        return anchored_response(self.get_serializer(project).data, anchor)

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
        log_action(
            request, "project.rejected",
            entity_type="Project", entity_id=project.id,
            description=f"Head rejected procurement {project.code}."
            + (f" Reason: {reason}" if reason else ""),
        )
        anchor = anchor_project(project, BlockchainAnchor.Stage.HEAD_REJECTED)
        return anchored_response(self.get_serializer(project).data, anchor)

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
        log_action(
            request, "project.revision_requested",
            entity_type="Project", entity_id=project.id,
            description=f"Head requested revision on {project.code}: {flagged}.",
        )
        anchor = anchor_project(project, BlockchainAnchor.Stage.REVISION_REQUESTED)
        return anchored_response(self.get_serializer(project).data, anchor)

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
        # The Head's approval is the gate this whole workflow exists to enforce,
        # so it is checked HERE and not only in the Admin UI. Without this an
        # admin could POST straight to this endpoint and put a draft — or a
        # procurement the Head had explicitly REJECTED — out to bidding.
        if project.status != Project.Status.APPROVED:
            return Response(
                {"detail": "Only a procurement approved by the Head can be published for bidding."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
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
        log_action(
            request, "project.published",
            entity_type="Project", entity_id=project.id,
            description=f"Published {project.code} for bidding"
            + (f" (deadline {project.deadline})." if project.deadline else "."),
        )
        # Anchored with the bid evaluation criteria document: this is the moment
        # the rules of the competition become public, so pinning them here is
        # what stops the criteria being quietly rewritten after bids are in.
        anchor = anchor_project(project, BlockchainAnchor.Stage.BIDDING_OPEN)
        return anchored_response(self.get_serializer(project).data, anchor)

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

    def destroy(self, request, *args, **kwargs):
        """Remove a supplier — only one that has never taken part in a bidding.

        Bid.supplier and Award.supplier both CASCADE, so deleting a supplier who
        has bid takes their bids (and any award) with them. Those rows are the
        evidence behind BID_SUBMITTED and AWARDED anchors that are already on
        Sepolia and cannot be withdrawn, so the deletion would quietly turn a
        verifiable procurement into one the public page reports as broken.
        Rejecting the delete is the reversible choice; the account can be
        rejected or deactivated instead.
        """
        supplier = self.get_object()
        bids = supplier.bids.count()
        awards = supplier.awards.count()
        if bids or awards:
            return Response(
                {"detail": f"{supplier.company} has {bids} bid(s) and {awards} award(s) on record "
                           "and cannot be deleted — the procurement history and its blockchain "
                           "trail depend on them. Reject the supplier instead to block them from "
                           "bidding."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

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
        log_action(
            request, "supplier.verified",
            entity_type="Supplier", entity_id=supplier.id,
            description=f"Verified supplier {supplier.company}.",
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
        log_action(
            request, "supplier.rejected",
            entity_type="Supplier", entity_id=supplier.id,
            description=f"Rejected supplier {supplier.company}."
            + (f" Reason: {reason}" if reason else ""),
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
        log_action(
            request, "supplier.revision_requested",
            entity_type="Supplier", entity_id=supplier.id,
            description=f"Requested document revision from {supplier.company}: {flagged}.",
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
        # A supplier anchors their own bid submission, the Admin anchors the
        # qualify/disqualify steps — both go through get_queryset, which already
        # scopes suppliers to their own bids, so this can't touch anyone else's.
        if self.action in {"list", "retrieve", "destroy", "anchor"}:
            return [permissions.IsAuthenticated()]
        return [IsAdminRole()]

    def list(self, request, *args, **kwargs):
        """Default list with each bid's anchors bulk-loaded (one extra query)."""
        bids = attach_anchors(
            self.filter_queryset(self.get_queryset()),
            ref_attr="project.code", entity_type=BlockchainAnchor.EntityType.BID, id_attr="id",
        )
        return Response(self.get_serializer(bids, many=True).data)

    @action(detail=True, methods=["post"])
    def anchor(self, request, pk=None):
        """Record the confirmed Sepolia transaction for one of this bid's anchors:
        { anchor_id | stage, tx_hash, block_number }."""
        bid = self.get_object()
        return attach_anchor_transaction(
            request, entity_ref=bid.project.code,
            entity_type=BlockchainAnchor.EntityType.BID, entity_id=bid.id,
        )

    def destroy(self, request, *args, **kwargs):
        """Withdraw a bid — only while the bidding is genuinely still open.

        A supplier may change their mind before the deadline. They may NOT
        delete a bid that has already won, or one belonging to a procurement
        that has closed or been awarded: the bid at that point is part of the
        evaluation record, it is referenced by the Award, and its BID_SUBMITTED
        anchor is on-chain — deleting the row leaves that anchor pointing at
        nothing, so the public verifier reports a real contract as
        "unavailable". Admins keep the unrestricted delete for cleanup.
        """
        bid = self.get_object()
        if getattr(request.user, "role", None) == "supplier":
            if bid.status == Bid.Status.WINNER:
                return Response(
                    {"detail": "This bid won the contract and can no longer be withdrawn. "
                               "Contact the procuring entity if you need to decline the award."},
                    status=http_status.HTTP_400_BAD_REQUEST,
                )
            if bid.project.status != Project.Status.PUBLISHED:
                return Response(
                    {"detail": "Bidding for this procurement is closed, so your bid can no longer "
                               "be withdrawn."},
                    status=http_status.HTTP_400_BAD_REQUEST,
                )
        return super().destroy(request, *args, **kwargs)

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
        # Qualification decisions are NOT anchored: they happen for every bidder,
        # and only the winner's bid goes on the public ledger. The decision is
        # still captured in the audit log and the notification to the supplier.
        return anchored_response(self.get_serializer(bid).data, None)

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
        log_action(
            request, "bid.qualified",
            entity_type="Bid", entity_id=bid.id,
            description=f"Qualified {bid.supplier.company}'s bid on {bid.project.code}.",
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
        log_action(
            request, "bid.disqualified",
            entity_type="Bid", entity_id=bid.id,
            description=f"Disqualified {bid.supplier.company}'s bid on {bid.project.code}.",
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

        # A procurement is awarded ONCE. Without this check a second call for a
        # different supplier passed straight through: get_or_create keys on
        # (project, supplier), so it created a SECOND Award row rather than
        # finding the first. The result was two suppliers both holding a `won`
        # award for the same contract, both shown on the public results page and
        # both anchored on-chain as the winner — a contradiction written into an
        # append-only ledger that can never be retracted.
        if project.status == Project.Status.AWARDED:
            existing = project.awards.filter(status=Award.Status.WON).select_related("supplier").first()
            winner = existing.supplier.company if existing else "another supplier"
            return Response(
                {"detail": f"\"{project.name}\" has already been awarded to {winner}. "
                           "An award cannot be reassigned once it has been made."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        # Only a bid that passed evaluation can win. The Admin UI already hides
        # the button unless the bid is qualified; this is the same rule on the
        # server, so an under-review or explicitly DISQUALIFIED bid can't be
        # awarded by calling the endpoint directly.
        if bid.status != Bid.Status.QUALIFIED:
            return Response(
                {"detail": "Only a bid that has been marked Qualified can be selected as the winner."},
                status=http_status.HTTP_400_BAD_REQUEST,
            )

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

        award, _ = Award.objects.get_or_create(
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

        log_action(
            request, "project.awarded",
            entity_type="Project", entity_id=project.id,
            description=f"Awarded {project.code} to {bid.supplier.company} for {bid.amount}.",
        )
        # The winning bid reaches the ledger here and nowhere else. Bids are not
        # anchored on submission or on qualification, because that would publish
        # every losing supplier's amount; only the bid that actually won the
        # contract is public business. Anchored BEFORE the award so the trail
        # reads in the order the events happened: the offer, then the award.
        anchor_bid(bid, BlockchainAnchor.Stage.BID_SUBMITTED)

        # Final link in the chain: the award itself, hashed with the winning
        # quotation. Anchored as AWARD (not BID) so the public trail ends with an
        # unambiguous "this contract went to this bid at this amount".
        anchor = anchor_award(award)
        return anchored_response(self.get_serializer(bid).data, anchor)


class AwardViewSet(viewsets.ModelViewSet):
    """Admin-only: contract amounts and award records. Awards are normally
    created by BidViewSet.select_winner — this CRUD API exists for the Admin
    Awards/Reports pages, never for suppliers (a supplier could otherwise
    award themselves a project or read every other supplier's contract value)."""

    queryset = Award.objects.select_related("project", "supplier").all()
    serializer_class = AwardSerializer
    # Post-award documents are uploaded as signed PDFs (multipart).
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_permissions(self):
        # The winning supplier may READ their own award — the Notice of Award is
        # addressed to them, and receiving it starts the clock for posting their
        # performance security. Everything that changes an award (issuing
        # documents, anchoring, CRUD) stays with the Admin.
        if self.action in {"list", "retrieve"}:
            return [permissions.IsAuthenticated()]
        return [IsAdminRole()]

    def get_queryset(self):
        qs = Award.objects.select_related("project", "supplier", "supplier__user", "bid")
        role = getattr(self.request.user, "role", None)
        if role == "supplier":
            # Scoped to their OWN award: a supplier must never see another
            # supplier's contract value or award documents.
            return qs.filter(supplier__user=self.request.user)
        if role in {"admin", "head"}:
            return qs
        return qs.none()

    def _issue_document(self, request, award, key, django_file, *, generated):
        """Save one post-award document, stamp its issue date, notify the winner
        and anchor it. Shared by the generate and upload paths so both produce an
        identical record — the only difference is where the bytes came from."""
        label = next(lbl for k, lbl, _, _ in AWARD_DOCUMENT_FIELDS if k == key)
        issued_field = AWARD_DOCUMENT_ISSUED_FIELDS[key]
        replacing = bool(getattr(award, key, None))

        setattr(award, key, django_file)
        setattr(award, issued_field, timezone.now())
        award.save(update_fields=[key, issued_field])

        notify_supplier(
            award.supplier,
            f"{label} issued for \"{award.project.name}\" ({award.project.code}).",
            link="/supplier/bids",
            email_subject=f"{label} for {award.project.code}",
        )
        log_action(
            request, "award.document_issued",
            entity_type="Award", entity_id=award.id,
            description=f"{'Replaced' if replacing else 'Issued'} {label} for {award.project.code}"
                        f" ({'generated' if generated else 'uploaded'}).",
        )
        # Anchored with the STORED file's hash and its issue date — the two
        # things a backdated or swapped notice would have to change. Re-issuing
        # appends a NEW anchor rather than editing the old one, so a replacement
        # is visible in the trail instead of silently overwriting history.
        anchor = anchor_award(award, AWARD_DOCUMENT_STAGES[key])
        return anchored_response(self.get_serializer(award).data, anchor)

    @action(detail=True, methods=["post"], url_path="documents/generate")
    def generate_document(self, request, pk=None):
        """Generate one official document from the award record — body: { key }.

        Filled in from what the system already knows (supplier, procurement,
        amount, delivery period), so the Admin never retypes it and the notice
        can't disagree with the award it refers to.

        Generated ONCE and stored: a PDF embeds a creation timestamp, so
        regenerating it on every download would change the hash and make the
        on-chain record unverifiable. Every later download serves these exact
        bytes."""
        award = self.get_object()

        key = (request.data.get("key") or "").strip()
        if key not in AWARD_DOCUMENT_KEYS:
            return Response({"detail": f"Unknown award document '{key}'."},
                            status=http_status.HTTP_400_BAD_REQUEST)

        try:
            pdf_bytes = DOCUMENT_BUILDERS[key](award)
        except Exception:
            logger.exception("Could not generate %s for award %s", key, award.id)
            return Response(
                {"detail": "Could not generate the document. Please try again or upload a signed copy."},
                status=http_status.HTTP_500_INTERNAL_SERVER_ERROR)

        filename = f"{key}_{award.project.code}.pdf"
        return self._issue_document(
            request, award, key, ContentFile(pdf_bytes, name=filename), generated=True)

    @action(detail=True, methods=["post"], url_path="documents")
    def upload_document(self, request, pk=None):
        """Admin uploads a SIGNED post-award document — body: { key, file }.

        The alternative to generating one: once the printed notice comes back
        signed, the scan replaces the generated draft and is anchored in its own
        right, so the trail shows both the draft and the executed copy.

        One document per request, so each produces exactly one anchor the browser
        can sign — mirroring how each is issued as a separate act."""
        award = self.get_object()

        key = (request.data.get("key") or "").strip()
        if key not in AWARD_DOCUMENT_KEYS:
            return Response(
                {"detail": f"Unknown award document '{key}'."},
                status=http_status.HTTP_400_BAD_REQUEST)

        uploaded = request.FILES.get("file")
        if uploaded is None:
            return Response({"detail": "Attach the signed document to upload."},
                            status=http_status.HTTP_400_BAD_REQUEST)
        # setattr()/save() never calls full_clean(), so the field's validators
        # would never run — check explicitly, same as the other upload paths.
        try:
            validate_upload(uploaded)
        except DjangoValidationError as exc:
            return Response({key: exc.messages}, status=http_status.HTTP_400_BAD_REQUEST)

        return self._issue_document(request, award, key, uploaded, generated=False)

    def list(self, request, *args, **kwargs):
        """Default list with each award's anchors bulk-loaded (one extra query)."""
        awards = attach_anchors(
            self.filter_queryset(self.get_queryset()),
            ref_attr="project.code", entity_type=BlockchainAnchor.EntityType.AWARD, id_attr="id",
        )
        return Response(self.get_serializer(awards, many=True).data)

    @action(detail=True, methods=["post"])
    def anchor(self, request, pk=None):
        """Record the confirmed Sepolia transaction for this award's anchor —
        the endpoint the Admin's browser posts to after signing the AWARDED
        anchor returned by /bids/{id}/select-winner/."""
        award = self.get_object()
        return attach_anchor_transaction(
            request, entity_ref=award.project.code,
            entity_type=BlockchainAnchor.EntityType.AWARD, entity_id=award.id,
        )


class DocumentViewSet(viewsets.ModelViewSet):
    """Admin-only: supplier compliance documents (expiry tracking)."""

    queryset = Document.objects.select_related("supplier").all()
    serializer_class = DocumentSerializer
    permission_classes = [IsAdminRole]


class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    """A user's own in-app notifications + a bulk 'mark read' action."""

    serializer_class = NotificationSerializer

    # The bell polls this list every 30 seconds for every signed-in user, and
    # notifications are never deleted — so an account that has been active for a
    # while was re-downloading its entire history twice a minute. The dropdown
    # only ever shows the most recent handful, so serving more is pure waste.
    MAX_NOTIFICATIONS = 50

    def get_queryset(self):
        """The caller's own notifications, newest first (Meta.ordering)."""
        return Notification.objects.filter(user=self.request.user)

    def list(self, request, *args, **kwargs):
        # Capped here rather than in get_queryset: a sliced queryset can't be
        # filtered or updated afterwards, which would break mark_read below.
        rows = self.get_queryset()[: self.MAX_NOTIFICATIONS]
        return Response(self.get_serializer(rows, many=True).data)

    @action(detail=False, methods=["post"], url_path="mark-read")
    def mark_read(self, request):
        self.get_queryset().filter(is_read=False).update(is_read=True)
        return Response({"detail": "All notifications marked as read."})
