"""Read-only summary endpoints for the role dashboards and the landing page.

Each dashboard home needs a handful of counts, short "needs your attention"
lists and small chart series. Computing those in the browser would mean
downloading every project, bid, supplier and anchor first (and there is no
audit-log endpoint at all), so these views return just the aggregates.

Rules shared by every view here:
  * GET only. Nothing is created, changed or anchored.
  * Aggregates come from COUNT/SUM queries or one bulk query per table — no
    per-row queries.
  * The public summary exposes only what PublicProcurementView already makes
    public, plus the WINNING amount of an awarded contract (a published award
    discloses it). Losing bids, supplier contacts and documents never appear.
"""
from datetime import timedelta

from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import AuditLog

from .blockchain import ETHERSCAN_TX_URL, anchor_summary
from .document_requirements import approved_categories, expiring_documents, missing_documents
from .models import Award, Bid, BlockchainAnchor, Project, Supplier
from .permissions import IsAdminRole, IsHeadRole
from .views import close_expired_published_projects

# Stages a Head decision is anchored under.
HEAD_DECISION_STAGES = {
    BlockchainAnchor.Stage.HEAD_APPROVED,
    BlockchainAnchor.Stage.HEAD_REJECTED,
    BlockchainAnchor.Stage.REVISION_REQUESTED,
}
# Statuses a project can only reach after the Head approved it.
POST_APPROVAL = [
    Project.Status.APPROVED, Project.Status.PUBLISHED,
    Project.Status.CLOSED, Project.Status.AWARDED,
]
ACTIVITY_LIMIT = 12
LIST_LIMIT = 6


def _money(value):
    return str(value or 0)


def _actor(user):
    if user is None:
        return {"name": "System", "role": ""}
    return {"name": user.full_name or user.username, "role": user.role}


def _waiting_since(projects):
    """When each pending project (re-)entered the Head's queue: its creation,
    or the Admin's latest document resubmission. One audit-log query."""
    ids = [str(p.id) for p in projects]
    latest = {}
    resubmits = AuditLog.objects.filter(
        action="project.documents_resubmitted", entity_type="Project", entity_id__in=ids,
    ).values_list("entity_id", "created_at")
    for entity_id, at in resubmits:
        if entity_id not in latest or at > latest[entity_id]:
            latest[entity_id] = at
    return {p.id: max(p.created_at, latest.get(str(p.id), p.created_at)) for p in projects}


class AdminSummaryView(APIView):
    """Everything the Admin dashboard home shows, in one request."""

    permission_classes = [IsAdminRole]

    def get(self, request):
        close_expired_published_projects()
        today = timezone.localdate()
        week_end = today + timedelta(days=7)

        published = Project.objects.filter(status=Project.Status.PUBLISHED)
        open_count = published.count()
        open_abc = published.aggregate(total=Sum("budget"))["total"]
        closing_week = published.filter(deadline__lte=week_end).count()

        # Bids still undecided on procurements that are not yet awarded.
        pending_bids = Bid.objects.filter(
            status=Bid.Status.UNDER_REVIEW,
        ).exclude(project__status=Project.Status.AWARDED)
        pending_bid_count = pending_bids.count()
        pending_on_closed = pending_bids.filter(project__status=Project.Status.CLOSED).count()

        suppliers = list(Supplier.objects.prefetch_related("category_documents"))
        to_verify = [s for s in suppliers if s.qualification_status == Supplier.Qualification.PENDING]
        category_requests = [
            s for s in suppliers if s.category_request_status == Supplier.CategoryRequest.PENDING]
        # Same database-only rule as SupplierListSerializer.documents_complete.
        incomplete = [
            s for s in suppliers
            if s.qualification_status != Supplier.Qualification.REJECTED and (
                missing_documents(s, approved_categories(s), check_storage=False)
                or expiring_documents(s, approved_categories(s)))
        ]

        anchors_pending = BlockchainAnchor.objects.filter(tx_hash="")
        pending_anchor_count = anchors_pending.count()
        anchored_count = BlockchainAnchor.objects.exclude(tx_hash="").count()

        # ── Needs your attention ─────────────────────────────────────────────
        attention = []
        closed_with_pending = (
            Project.objects.filter(status=Project.Status.CLOSED)
            .annotate(pending=Count("bids", filter=Q(bids__status=Bid.Status.UNDER_REVIEW)))
            .filter(pending__gt=0)
            .order_by("deadline")
        )
        for p in closed_with_pending:
            attention.append({
                "kind": "evaluate", "tone": "danger",
                "title": f"Evaluate {p.pending} bid{'s' if p.pending != 1 else ''} on {p.code}",
                "detail": f"{p.name} · bidding closed {p.deadline.isoformat() if p.deadline else ''}".strip(),
                "link": f"/admin/bids/{p.id}", "since": p.deadline,
            })
        for p in Project.objects.filter(status=Project.Status.NEEDS_REVISION).order_by("reviewed_at"):
            attention.append({
                "kind": "revision", "tone": "warning",
                "title": f"{p.code} returned by the Head",
                "detail": f"{p.name} · fix the flagged documents and resubmit",
                "link": "/admin/planning", "since": p.reviewed_at,
            })
        for s in sorted(to_verify, key=lambda s: s.registered):
            attention.append({
                "kind": "verify", "tone": "warning",
                "title": f"Verify supplier {s.company}",
                "detail": "Registration documents are waiting for review",
                "link": "/admin/suppliers", "since": s.registered,
            })
        for s in category_requests:
            attention.append({
                "kind": "category", "tone": "info",
                "title": f"Category change request from {s.company}",
                "detail": ", ".join(s.pending_business_types or []),
                "link": "/admin/suppliers", "since": s.category_requested_at,
            })
        for p in Project.objects.filter(status=Project.Status.APPROVED).order_by("reviewed_at"):
            attention.append({
                "kind": "publish", "tone": "info",
                "title": f"Publish {p.code} for bidding",
                "detail": f"{p.name} · approved by the Head",
                "link": "/admin/projects", "since": p.reviewed_at,
            })
        awards = list(Award.objects.filter(status=Award.Status.WON).select_related("project", "supplier"))
        for a in awards:
            missing = [label for field, label in (
                ("award_resolution", "BAC Resolution"), ("notice_of_award", "NOA"),
                ("notice_to_proceed", "NTP")) if not getattr(a, field)]
            if missing:
                attention.append({
                    "kind": "award_docs", "tone": "warning",
                    "title": f"Issue {', '.join(missing)} for {a.project.code}",
                    "detail": f"{a.project.name} · awarded to {a.supplier.company}",
                    "link": "/admin/awards", "since": a.awarded_at,
                })
        if pending_anchor_count:
            attention.append({
                "kind": "anchor", "tone": "neutral",
                "title": f"{pending_anchor_count} step{'s' if pending_anchor_count != 1 else ''} waiting to be anchored on-chain",
                "detail": "Sign them from Blockchain health below",
                "link": "/admin#chain", "since": None,
            })
        rank = {"danger": 0, "warning": 1, "info": 2, "neutral": 3}
        attention.sort(key=lambda i: (rank[i["tone"]], str(i["since"] or "9999")))

        # ── Pipeline (one grouped COUNT) ─────────────────────────────────────
        by_status = dict(Project.objects.values_list("status").annotate(n=Count("id")))
        closed_with_bids = Project.objects.filter(
            status=Project.Status.CLOSED, bids__isnull=False).distinct().count()
        pipeline = [
            {"key": "draft", "label": "Draft", "count": by_status.get("draft", 0)},
            {"key": "pending_head", "label": "Head Review", "count": by_status.get("pending_head", 0)},
            {"key": "needs_revision", "label": "Needs Revision", "count": by_status.get("needs_revision", 0)},
            {"key": "approved", "label": "Ready to Publish", "count": by_status.get("approved", 0)},
            {"key": "published", "label": "Published", "count": by_status.get("published", 0)},
            {"key": "evaluation", "label": "Evaluation", "count": closed_with_bids},
            {"key": "awarded", "label": "Awarded", "count": by_status.get("awarded", 0)},
            {"key": "closed", "label": "Closed (no bids)",
             "count": by_status.get("closed", 0) - closed_with_bids},
        ]

        closing_soon = [
            {"id": p.id, "code": p.code, "name": p.name, "category": p.category,
             "budget": _money(p.budget), "deadline": p.deadline, "bids": p.num_bids}
            for p in published.annotate(num_bids=Count("bids")).order_by("deadline", "code")[:LIST_LIMIT]
        ]

        savings_rows = []
        total_abc = total_awarded = 0
        for a in sorted(awards, key=lambda a: a.awarded_at, reverse=True):
            abc, amount = a.project.budget or 0, a.amount or 0
            total_abc += abc
            total_awarded += amount
            savings_rows.append({
                "code": a.project.code, "name": a.project.name, "supplier": a.supplier.company,
                "abc": _money(abc), "amount": _money(amount), "saved": _money(abc - amount),
                "saved_pct": round(float((abc - amount) / abc * 100), 1) if abc else None,
                "awarded_at": a.awarded_at,
            })

        categories = [
            {"category": row["category"] or "Uncategorised", "count": row["n"], "abc": _money(row["abc"])}
            for row in Project.objects.values("category").annotate(n=Count("id"), abc=Sum("budget")).order_by("-n", "category")
        ]

        activity = [
            {"id": log.id, "action": log.action, "description": log.description,
             "entity_type": log.entity_type, "created_at": log.created_at, "actor": _actor(log.user)}
            for log in AuditLog.objects.select_related("user").exclude(action__startswith="auth.")[:ACTIVITY_LIMIT]
        ]

        return Response({
            "kpis": {
                "open_biddings": open_count,
                "closing_this_week": closing_week,
                "bids_awaiting_evaluation": pending_bid_count,
                "bids_awaiting_on_closed": pending_on_closed,
                "suppliers_awaiting_verification": len(to_verify),
                "suppliers_incomplete_documents": len(incomplete),
                "category_requests": len(category_requests),
                "anchors_pending": pending_anchor_count,
                "open_abc": _money(open_abc),
            },
            "attention": attention,
            "pipeline": pipeline,
            "closing_soon": closing_soon,
            "savings": {
                "total_abc": _money(total_abc), "total_awarded": _money(total_awarded),
                "total_saved": _money(total_abc - total_awarded),
                "saved_pct": round(float((total_abc - total_awarded) / total_abc * 100), 1) if total_abc else None,
                "rows": savings_rows[:LIST_LIMIT],
            },
            "categories": categories,
            "activity": activity,
            "chain": {
                "anchored": anchored_count,
                "pending": pending_anchor_count,
                # Full anchor shape, so "Anchor now" can reuse runAnchor().
                "pending_items": [anchor_summary(a) for a in anchors_pending.order_by("-created_at", "-id")[:8]],
            },
        })


class HeadSummaryView(APIView):
    """The Head's approval queue metadata, KPIs and decision history."""

    permission_classes = [IsHeadRole]

    def get(self, request):
        now = timezone.now()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        pending = list(Project.objects.filter(status=Project.Status.PENDING_HEAD)
                       .select_related("created_by").order_by("created_at"))
        since = _waiting_since(pending)

        reviewed = list(Project.objects.filter(reviewed_at__isnull=False).order_by("-reviewed_at")[:10])
        decision_anchors = {}
        for a in BlockchainAnchor.objects.filter(
                entity_type=BlockchainAnchor.EntityType.PROJECT,
                entity_ref__in=[p.code for p in reviewed], stage__in=HEAD_DECISION_STAGES):
            current = decision_anchors.get(a.entity_ref)
            if current is None or (a.created_at, a.id) > (current.created_at, current.id):
                decision_anchors[a.entity_ref] = a

        def decision(p):
            if p.status == Project.Status.REJECTED:
                return "rejected"
            if p.status in (Project.Status.NEEDS_REVISION, Project.Status.PENDING_HEAD):
                return "revision"
            return "approved"

        history = []
        for p in reviewed:
            a = decision_anchors.get(p.code)
            history.append({
                "id": p.id, "code": p.code, "name": p.name, "budget": _money(p.budget),
                "decision": decision(p), "reviewed_at": p.reviewed_at,
                "anchor": anchor_summary(a),
            })

        return Response({
            "kpis": {
                "waiting": len(pending),
                "approved_this_month": Project.objects.filter(
                    status__in=POST_APPROVAL, reviewed_at__gte=month_start).count(),
                "returned_for_revision": Project.objects.filter(status=Project.Status.NEEDS_REVISION).count(),
                "rejected": Project.objects.filter(status=Project.Status.REJECTED).count(),
            },
            "queue": [
                {"id": p.id, "code": p.code,
                 "created_by": (p.created_by.full_name or p.created_by.username) if p.created_by else "",
                 "waiting_since": since[p.id]}
                for p in pending
            ],
            "history": history,
        })


class PublicSummaryView(APIView):
    """Live numbers for the landing page. No login, public fields only."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def get(self, request):
        close_expired_published_projects()
        published = Project.objects.filter(status=Project.Status.PUBLISHED)
        ever_published = Project.objects.filter(
            status__in=[Project.Status.PUBLISHED, Project.Status.CLOSED, Project.Status.AWARDED])
        won = Award.objects.filter(status=Award.Status.WON)

        recent = list(won.select_related("project", "supplier").order_by("-awarded_at", "-id")[:LIST_LIMIT])
        award_tx = {}
        for a in BlockchainAnchor.objects.filter(
                entity_type=BlockchainAnchor.EntityType.AWARD, stage=BlockchainAnchor.Stage.AWARDED,
                entity_id__in=[str(a.id) for a in recent]).exclude(tx_hash=""):
            award_tx[a.entity_id] = a.tx_hash

        return Response({
            "open_biddings": published.count(),
            "awarded_contracts": won.count(),
            "total_published_abc": _money(ever_published.aggregate(total=Sum("budget"))["total"]),
            "open": [
                {"code": p.code, "name": p.name, "category": p.category, "budget": _money(p.budget),
                 "deadline": p.deadline, "published_at": p.published_at, "bids": p.num_bids}
                for p in published.annotate(num_bids=Count("bids")).order_by("deadline", "code")[:LIST_LIMIT]
            ],
            "awards": [
                {"code": a.project.code, "name": a.project.name, "category": a.project.category,
                 "winner": a.supplier.company, "amount": _money(a.amount), "awarded_at": a.awarded_at,
                 "anchored": str(a.id) in award_tx,
                 "explorer_url": (ETHERSCAN_TX_URL + award_tx[str(a.id)]) if str(a.id) in award_tx else ""}
                for a in recent
            ],
        })
