"""Endpoints of the separation-of-duties workflow (docs/BAC_ROLES_PLAN.md).

    /api/bac/status/                              everyone signed in: is the workflow on, my seat
    /api/bac/memberships/                         internal read; Admin records a designation
    /api/bac/memberships/<id>/end/                Admin ends a seat (resignation, end of term)
    /api/bac/projects/                            internal: procurements in or after evaluation
    /api/bac/projects/<id>/                       internal: one procurement's bids, evaluations, ranking
    /api/bac/bids/<id>/evaluate/                  BAC member: my checklist for this bid
    /api/bac/bids/<id>/post-qualify/              BAC Chairperson: finding on the top candidate
    /api/bac/resolutions/                         internal read (BAC Records); Staff drafts one
    /api/bac/resolutions/<id>/open-voting/        Staff
    /api/bac/resolutions/<id>/vote/               BAC member, with a required comment
    /api/bac/resolutions/<id>/record-vote/        Staff: a vote given at an in-person meeting
    /api/bac/votes/<id>/notes/                    the voter or Staff: a correction note (vote unchanged)
    /api/bac/resolutions/<id>/approve/            Head: makes the award (same code, same anchors)
    /api/bac/resolutions/<id>/return/             Head: sends it back, with remarks

Rules live in procurement/bac.py. Each write follows the house pattern: change
the record, notify, audit-log, and (only for the award) anchor.

Everything that changes something refuses while settings.BAC_WORKFLOW_ENABLED
is off, except recording designations: the committee has to be set up before
the workflow is switched on.
"""
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import permissions, serializers, status as http_status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.audit import log_action

from . import bac
from .blockchain import anchor_award, anchor_bid, anchor_evaluation, anchor_summary
from .files import protected_file_url
from .models import (
    BACMembership,
    BACResolution,
    BACVote,
    BACVoteNote,
    Bid,
    BidEvaluation,
    BidPostQualification,
    BlockchainAnchor,
    Project,
)
from .notifications import notify_bac_members, notify_heads, notify_staff, notify_supplier
from .permissions import (
    IsAdminRole,
    IsBACRole,
    IsHeadRole,
    IsInternalRole,
    IsStaffRole,
    bac_workflow_on,
)
from .validators import validate_upload

WORKFLOW_OFF = Response(
    {"detail": "The BAC Committee workflow is not switched on yet. Bids are still evaluated "
               "and awarded the original way.", "code": "bac_workflow_off"},
    status=http_status.HTTP_409_CONFLICT)


def _workflow_off():
    if bac_workflow_on():
        return None
    return Response(dict(WORKFLOW_OFF.data), status=WORKFLOW_OFF.status_code)


def _bad(detail, code=http_status.HTTP_400_BAD_REQUEST):
    return Response({"detail": detail}, status=code)


def _person(user):
    return (user.full_name or user.username) if user else ""


# ── Serializers ──────────────────────────────────────────────────────────────

class MembershipSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()
    username = serializers.CharField(source="user.username", read_only=True)
    position_label = serializers.CharField(source="get_position_display", read_only=True)
    recorded_by_name = serializers.SerializerMethodField()
    designation_document_url = serializers.SerializerMethodField()

    class Meta:
        model = BACMembership
        fields = ["id", "user", "username", "name", "position", "position_label", "designated_on",
                  "designation_reference", "designation_document_url", "recorded_by_name",
                  "recorded_at", "active", "ended_on", "end_reason"]
        read_only_fields = ["recorded_at", "active", "ended_on", "end_reason"]
        # The seat rules (one Chairperson, one Vice-Chairperson, one seat per
        # person, five seats) are checked in MembershipViewSet.create under a
        # lock, with messages that say what to do; DRF's generic ones would not.
        validators = []

    def get_name(self, m):
        return _person(m.user)

    def get_recorded_by_name(self, m):
        return _person(m.recorded_by)

    def get_designation_document_url(self, m):
        return protected_file_url(self.context.get("request"), "bacmembership", m, "designation_document") or ""


class VoteNoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = BACVoteNote
        fields = ["id", "note", "author_name", "author_role", "created_at"]


class VoteSerializer(serializers.ModelSerializer):
    choice_label = serializers.CharField(source="get_choice_display", read_only=True)
    position_label = serializers.CharField(source="get_voter_position_display", read_only=True)
    source_label = serializers.CharField(source="get_source_display", read_only=True)
    member_active = serializers.BooleanField(source="member.active", read_only=True)
    member_ended_on = serializers.DateField(source="member.ended_on", read_only=True)
    member_user = serializers.IntegerField(source="member.user_id", read_only=True)
    notes = VoteNoteSerializer(many=True, read_only=True)

    class Meta:
        model = BACVote
        fields = ["id", "member", "member_user", "voter_name", "voter_position", "position_label", "choice",
                  "choice_label", "comment", "cast_at", "source", "source_label", "recorded_by_name",
                  "member_active", "member_ended_on", "notes"]


class ResolutionSerializer(serializers.ModelSerializer):
    project_code = serializers.CharField(source="project.code", read_only=True)
    project_name = serializers.CharField(source="project.name", read_only=True)
    project_status = serializers.CharField(source="project.status", read_only=True)
    recommended_company = serializers.CharField(source="recommended_bid.supplier.company", read_only=True)
    recommended_amount = serializers.DecimalField(
        source="recommended_bid.amount", max_digits=14, decimal_places=2, read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    head_decision_label = serializers.CharField(source="get_head_decision_display", read_only=True)
    meeting_mode_label = serializers.CharField(source="get_meeting_mode_display", read_only=True)
    prepared_by_name = serializers.SerializerMethodField()
    head_decided_by_name = serializers.SerializerMethodField()
    votes = VoteSerializer(many=True, read_only=True)
    counts = serializers.SerializerMethodField()
    minutes_url = serializers.SerializerMethodField()
    resolution_file_url = serializers.SerializerMethodField()

    class Meta:
        model = BACResolution
        fields = ["id", "number", "project", "project_code", "project_name", "project_status",
                  "recommended_bid", "recommended_company", "recommended_amount", "meeting_date",
                  "meeting_mode", "meeting_mode_label", "venue", "justification", "minutes_url",
                  "prepared_by_name", "status", "status_label", "created_at", "voting_opened_at",
                  "decided_at", "resolution_file_url", "resolution_sha256", "head_decision",
                  "head_decision_label", "head_remarks", "head_decided_by_name", "head_decided_at",
                  "votes", "counts"]

    def get_prepared_by_name(self, r):
        return _person(r.prepared_by)

    def get_head_decided_by_name(self, r):
        return _person(r.head_decided_by)

    def get_counts(self, r):
        return bac.vote_counts(r)

    def _url(self, r, field):
        return protected_file_url(self.context.get("request"), "bacresolution", r, field) or ""

    def get_minutes_url(self, r):
        return self._url(r, "minutes")

    def get_resolution_file_url(self, r):
        return self._url(r, "resolution_file")


def _evaluation_row(e, *, show):
    """One member's evaluation. `show` False hides the content (a member who
    hasn't evaluated this bid yet sees that others have, but not what they found)."""
    row = {"member_id": e.member_id, "name": _person(e.member.user),
           "position": e.member.get_position_display(), "updated_at": e.updated_at}
    if show:
        row.update({"eligibility_ok": e.eligibility_ok, "technical_ok": e.technical_ok,
                    "financial_ok": e.financial_ok, "passed": e.passed, "remarks": e.remarks})
    return row


# ── Status and designations ──────────────────────────────────────────────────

class BACStatusView(APIView):
    """GET {workflow_enabled, membership, seats, majority, active_members}.
    Any signed-in account: the dashboards use it to decide what to show."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        seat = bac.membership_for(request.user)
        return Response({
            "workflow_enabled": bac_workflow_on(),
            "membership": MembershipSerializer(seat, context={"request": request}).data if seat else None,
            "seats": BACMembership.SEATS,
            "majority": BACMembership.MAJORITY,
            "active_members": bac.active_members().count(),
        })


class MembershipViewSet(viewsets.ReadOnlyModelViewSet):
    """BAC designations. Internal accounts read them; the Admin records and ends them."""

    serializer_class = MembershipSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    queryset = BACMembership.objects.select_related("user", "recorded_by")

    def get_permissions(self):
        if self.action in {"create", "end"}:
            return [IsAdminRole()]
        return [IsInternalRole()]

    def create(self, request):
        """POST {user, position, designated_on, designation_reference, designation_document?}.
        Records a designation the Head made. Refused when the account isn't a
        BAC Committee account, when it is the Head's, when the seat is taken or
        when all five seats are filled."""
        serializer = MembershipSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        position = serializer.validated_data["position"]
        if user.role == "head":
            return _bad("The Head of the Procuring Entity can't be a member of the BAC Committee.")
        if user.role != "bac" or not user.is_active:
            return _bad("Only an active BAC Committee account can hold a seat. Create the account "
                        "first, with the BAC Committee role.")
        document = request.FILES.get("designation_document")
        if document is not None:
            try:
                validate_upload(document)
            except Exception as exc:  # Django ValidationError
                return Response({"designation_document": getattr(exc, "messages", [str(exc)])},
                                status=http_status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            seats = list(BACMembership.objects.select_for_update().filter(active=True))
            if any(s.user_id == user.id for s in seats):
                return _bad(f"{_person(user)} already holds a seat on the committee.")
            if len(seats) >= BACMembership.SEATS:
                return _bad(f"All {BACMembership.SEATS} seats are filled. End a designation first.")
            if position != BACMembership.Position.MEMBER and any(s.position == position for s in seats):
                label = BACMembership.Position(position).label
                return _bad(f"There is already an active {label}. End that designation first.")
            try:
                seat = serializer.save(recorded_by=request.user, designation_document=document)
            except IntegrityError:
                return _bad("That seat was just filled by someone else. Refresh and try again.",
                            http_status.HTTP_409_CONFLICT)
        log_action(request, "bac.designation_recorded", entity_type="BACMembership", entity_id=seat.pk,
                   description=f"Recorded {_person(user)} as BAC {seat.get_position_display()} "
                               f"({seat.designation_reference}, {seat.designated_on}).")
        return Response(MembershipSerializer(seat, context={"request": request}).data,
                        status=http_status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def end(self, request, pk=None):
        """POST {ended_on?, end_reason}. Ends the seat; its votes and evaluations stay."""
        seat = self.get_object()
        if not seat.active:
            return _bad("This designation has already ended.")
        reason = (request.data.get("end_reason") or "").strip()
        if not reason:
            return _bad("Give a reason, for example \"Resigned\" or \"End of term\".")
        ended_on = timezone.localdate()
        if request.data.get("ended_on"):
            try:
                ended_on = serializers.DateField().to_internal_value(request.data["ended_on"])
            except serializers.ValidationError:
                return _bad("Enter the end date as YYYY-MM-DD.")
        seat.active = False
        seat.ended_on = ended_on
        seat.end_reason = reason[:200]
        seat.save(update_fields=["active", "ended_on", "end_reason"])
        log_action(request, "bac.designation_ended", entity_type="BACMembership", entity_id=seat.pk,
                   description=f"Ended {_person(seat.user)}'s seat as {seat.get_position_display()}: {reason}.")
        return Response(MembershipSerializer(seat, context={"request": request}).data)


# ── Evaluation ───────────────────────────────────────────────────────────────

EVALUATION_STATUSES = [Project.Status.PUBLISHED, Project.Status.CLOSED, Project.Status.AWARDED]


def _project_summary(project, seat):
    bids = list(project.bids.all())
    evaluations = [e for b in bids for e in b.evaluations.all()]
    res = next((r for r in project.bac_resolutions.all() if r.status in BACResolution.OPEN_STATUSES), None)
    latest = next(iter(project.bac_resolutions.all()), None)
    return {
        "id": project.id, "code": project.code, "name": project.name, "category": project.category,
        "status": project.status, "deadline": project.deadline, "budget": str(project.budget),
        "bidding_closed": bac.bidding_closed(project),
        "bid_count": len(bids),
        "evaluations_done": len(evaluations),
        "evaluations_expected": len(bids) * bac.active_members().count(),
        "my_evaluations": sum(1 for e in evaluations if seat and e.member_id == seat.id),
        "qualified": sum(1 for b in bids if b.status in (Bid.Status.QUALIFIED, Bid.Status.WINNER)),
        "post_qualified": any(hasattr(b, "post_qualification") for b in bids),
        "resolution": ({"id": res.id, "number": res.number, "status": res.status,
                        "head_decision": res.head_decision} if res else None),
        "latest_resolution_status": latest.status if latest else "",
    }


class EvaluationProjectsView(APIView):
    """GET the procurements that are, or have been, through BAC evaluation."""

    permission_classes = [IsInternalRole]

    def get(self, request):
        seat = bac.membership_for(request.user)
        projects = (Project.objects.filter(status__in=EVALUATION_STATUSES, bids__isnull=False).distinct()
                    .prefetch_related("bids__evaluations", "bids__post_qualification", "bac_resolutions")
                    .order_by("-deadline", "-id"))
        rows = [_project_summary(p, seat) for p in projects]
        # Only procurements whose bidding has closed: before that bids are sealed.
        return Response([r for r in rows if r["bidding_closed"] or r["status"] == Project.Status.AWARDED])


class UpcomingEvaluationsView(APIView):
    """GET the published procurements whose bidding is still open, so members
    can see what is coming and the day evaluation opens. Bids are sealed until
    the deadline, so this says nothing about them: no count, no amounts, no
    bidders. Evaluation opens the day after the deadline (bac.bidding_closed
    uses deadline < today)."""

    permission_classes = [IsInternalRole]

    def get(self, request):
        projects = (Project.objects.filter(status=Project.Status.PUBLISHED)
                    .order_by("deadline", "id"))
        rows = []
        for p in projects:
            if bac.bidding_closed(p):
                continue
            opens = p.deadline + timedelta(days=1) if p.deadline else None
            rows.append({"id": p.id, "code": p.code, "name": p.name, "category": p.category,
                         "deadline": p.deadline, "evaluation_opens": opens})
        return Response(rows)


class EvaluationProjectDetailView(APIView):
    """GET one procurement's bids, each member's evaluation, the ranking and
    the resolutions. A BAC member sees the content of other members'
    evaluations of a bid only after submitting their own."""

    permission_classes = [IsInternalRole]

    def get(self, request, pk):
        project = Project.objects.filter(pk=pk).first()
        if project is None:
            return _bad("Procurement not found.", http_status.HTTP_404_NOT_FOUND)
        if not (bac.bidding_closed(project) or project.status == Project.Status.AWARDED):
            return _bad("Bids stay sealed until the bidding deadline has passed.", http_status.HTTP_409_CONFLICT)
        seat = bac.membership_for(request.user)
        is_member = request.user.role == "bac"
        bids = (project.bids.select_related("supplier")
                .prefetch_related("evaluations__member__user").order_by("amount", "submitted_at"))
        rows = []
        for bid in bids:
            evaluations = list(bid.evaluations.all())
            mine = next((e for e in evaluations if seat and e.member_id == seat.id), None)
            show_all = not is_member or mine is not None
            pq = getattr(bid, "post_qualification", None)
            rows.append({
                "id": bid.id, "company": bid.supplier.company, "amount": str(bid.amount),
                "status": bid.status, "submitted_at": bid.submitted_at,
                "delivery_timeline": bid.delivery_timeline, "brand_name": bid.brand_name,
                "model_number": bid.model_number, "warranty_period": bid.warranty_period,
                "tally": bac.tally(bid),
                "my_evaluation": _evaluation_row(mine, show=True) if mine else None,
                "evaluations": [_evaluation_row(e, show=show_all) for e in evaluations],
                "post_qualification": ({"result": pq.result, "result_label": pq.get_result_display(),
                                        "remarks": pq.remarks, "recorded_at": pq.recorded_at,
                                        "recorded_by": _person(pq.recorded_by)} if pq else None),
            })
        resolutions = project.bac_resolutions.select_related(
            "recommended_bid__supplier", "prepared_by", "head_decided_by", "project").prefetch_related(
            "votes__member", "votes__notes")
        return Response({
            "project": _project_summary(
                Project.objects.prefetch_related("bids__evaluations", "bids__post_qualification",
                                                 "bac_resolutions").get(pk=project.pk), seat),
            "workflow_enabled": bac_workflow_on(),
            "membership": MembershipSerializer(seat, context={"request": request}).data if seat else None,
            "lock_reason": bac.evaluation_lock_reason(project),
            "bids": rows,
            "ranking": bac.ranking(project),
            "resolutions": ResolutionSerializer(resolutions, many=True, context={"request": request}).data,
        })


def _bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "1", "yes", "pass"}:
        return True
    if isinstance(value, str) and value.lower() in {"false", "0", "no", "fail"}:
        return False
    return None


class EvaluateBidView(APIView):
    """POST {eligibility_ok, technical_ok, financial_ok, remarks} - this
    member's evaluation of one bid (created, or updated until voting starts).
    The bid's status follows the majority of members (bac.apply_majority)."""

    permission_classes = [IsBACRole]

    def post(self, request, pk):
        off = _workflow_off()
        if off:
            return off
        seat = bac.membership_for(request.user)
        if seat is None:
            return _bad("You don't hold an active seat on the BAC Committee.", http_status.HTTP_403_FORBIDDEN)
        checks = {k: _bool(request.data.get(k)) for k in ("eligibility_ok", "technical_ok", "financial_ok")}
        missing = [k for k, v in checks.items() if v is None]
        if missing:
            return _bad("Mark each check as passed or failed: eligibility, technical and financial.")
        remarks = (request.data.get("remarks") or "").strip()
        if not all(checks.values()) and len(remarks) < 5:
            return _bad("Explain in the remarks why the bid fails.")
        with transaction.atomic():
            bid = Bid.objects.select_for_update().select_related("project", "supplier").filter(pk=pk).first()
            if bid is None:
                return _bad("Bid not found.", http_status.HTTP_404_NOT_FOUND)
            reason = bac.evaluation_lock_reason(bid.project)
            if reason:
                return _bad(reason)
            evaluation, created = BidEvaluation.objects.update_or_create(
                bid=bid, member=seat, defaults={**checks, "remarks": remarks})
            old, new = bac.apply_majority(bid)
        verdict = "passed" if evaluation.passed else "failed"
        log_action(request, "bac.bid_evaluated", entity_type="Bid", entity_id=bid.id,
                   description=f"{_person(request.user)} ({seat.get_position_display()}) "
                               f"{'evaluated' if created else 'revised the evaluation of'} "
                               f"{bid.supplier.company}'s bid on {bid.project.code}: {verdict}.")
        if new != old and new in (Bid.Status.QUALIFIED, Bid.Status.DISQUALIFIED):
            word = "qualified for evaluation" if new == Bid.Status.QUALIFIED else "was disqualified"
            notify_supplier(bid.supplier, f"Your bid on \"{bid.project.name}\" ({bid.project.code}) {word}.",
                            link="/supplier/bids", email_subject=f"Your bid on {bid.project.code} {word}")
        return Response({"evaluation": _evaluation_row(evaluation, show=True), "bid_status": new,
                         "tally": bac.tally(bid)}, status=201 if created else 200)


class PostQualifyView(APIView):
    """POST {result: passed|failed, remarks} - the Chairperson records the
    committee's post-qualification finding on the current top candidate."""

    permission_classes = [IsBACRole]

    def post(self, request, pk):
        off = _workflow_off()
        if off:
            return off
        seat = bac.membership_for(request.user)
        if seat is None or seat.position != BACMembership.Position.CHAIR:
            return _bad("Only the BAC Chairperson records the post-qualification finding.",
                        http_status.HTTP_403_FORBIDDEN)
        result = (request.data.get("result") or "").strip()
        remarks = (request.data.get("remarks") or "").strip()
        if result not in BidPostQualification.Result.values:
            return _bad("Choose whether the bid passed or failed post-qualification.")
        if len(remarks) < 5:
            return _bad("Write down what the committee verified and found.")
        with transaction.atomic():
            bid = Bid.objects.select_for_update().select_related("project", "supplier").filter(pk=pk).first()
            if bid is None:
                return _bad("Bid not found.", http_status.HTTP_404_NOT_FOUND)
            reason = bac.evaluation_lock_reason(bid.project)
            if reason:
                return _bad(reason)
            if bac.open_resolution(bid.project) is not None:
                return _bad("A resolution has already been drafted for this procurement.")
            if bac.ranking(bid.project)["candidate_id"] != bid.id:
                return _bad("Post-qualification is done on the lowest-ranked bid that passed "
                            "evaluation and hasn't failed post-qualification yet. This isn't that bid.")
            if BidPostQualification.objects.filter(bid=bid).exists():
                return _bad("This bid's post-qualification has already been recorded.")
            pq = BidPostQualification.objects.create(bid=bid, result=result, remarks=remarks,
                                                     recorded_by=request.user)
            if result == BidPostQualification.Result.FAILED:
                bid.status = Bid.Status.DISQUALIFIED
                bid.reviewed_at = timezone.now()
                bid.save(update_fields=["status", "reviewed_at"])
        log_action(request, "bac.post_qualified", entity_type="Bid", entity_id=bid.id,
                   description=f"Post-qualification of {bid.supplier.company} on {bid.project.code}: "
                               f"{pq.get_result_display()}.")
        if result == BidPostQualification.Result.FAILED:
            notify_supplier(bid.supplier,
                            f"Your bid on \"{bid.project.name}\" ({bid.project.code}) did not pass "
                            f"post-qualification.", link="/supplier/bids",
                            email_subject=f"Post-qualification result for {bid.project.code}")
        else:
            notify_staff(f"{bid.supplier.company} passed post-qualification on {bid.project.code}. "
                         f"The resolution can be drafted.", link="/staff/bac-meetings")
        return Response({"result": pq.result, "ranking": bac.ranking(bid.project)}, status=201)


# ── Resolutions, votes and the Head's decision ───────────────────────────────

class ResolutionViewSet(viewsets.ReadOnlyModelViewSet):
    """BAC Resolutions. Internal accounts read them (the BAC Records page);
    Staff drafts and opens voting, members vote, the Head decides."""

    serializer_class = ResolutionSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_permissions(self):
        if self.action in {"create", "open_voting", "discard", "record_vote"}:
            return [IsStaffRole()]
        if self.action == "vote":
            return [IsBACRole()]
        if self.action in {"approve", "return_to_bac"}:
            return [IsHeadRole()]
        return [IsInternalRole()]

    def get_queryset(self):
        qs = (BACResolution.objects
              .select_related("project", "recommended_bid__supplier", "prepared_by", "head_decided_by")
              .prefetch_related("votes__member", "votes__notes"))
        params = self.request.query_params
        if params.get("project"):
            qs = qs.filter(project_id=params["project"])
        if params.get("status"):
            qs = qs.filter(status__in=params["status"].split(","))
        if params.get("head_decision"):
            qs = qs.filter(head_decision=params["head_decision"])
        if params.get("year"):
            qs = qs.filter(meeting_date__year=params["year"])
        if params.get("member"):
            qs = qs.filter(votes__member_id=params["member"]).distinct()
        if params.get("q"):
            q = params["q"].strip()
            from django.db.models import Q  # noqa: PLC0415
            qs = qs.filter(Q(project__code__icontains=q) | Q(project__name__icontains=q) | Q(number__icontains=q))
        return qs

    def create(self, request):
        """POST {project, meeting_date, meeting_mode, venue?, justification, minutes?}.
        The recommended bid is not chosen here: it is the ranking's Lowest
        Calculated Responsive Bid (bac.ranking), the bid that passed post-qualification."""
        off = _workflow_off()
        if off:
            return off
        data = request.data
        justification = (data.get("justification") or "").strip()
        if len(justification) < 10:
            return _bad("Write the basis of the recommendation (at least a sentence).")
        try:
            meeting_date = serializers.DateField().to_internal_value(data.get("meeting_date") or "")
        except serializers.ValidationError:
            return _bad("Enter the meeting date.")
        mode = data.get("meeting_mode") or BACResolution.MeetingMode.IN_PERSON
        if mode not in BACResolution.MeetingMode.values:
            return _bad("Choose whether the meeting was in person or online.")
        minutes = request.FILES.get("minutes")
        if minutes is not None:
            try:
                validate_upload(minutes)
            except Exception as exc:
                return Response({"minutes": getattr(exc, "messages", [str(exc)])},
                                status=http_status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            project = Project.objects.select_for_update().filter(pk=data.get("project") or 0).first()
            if project is None:
                return _bad("Procurement not found.", http_status.HTTP_404_NOT_FOUND)
            if project.status == Project.Status.AWARDED:
                return _bad("This procurement has already been awarded.")
            if not bac.bidding_closed(project):
                return _bad("A resolution can be drafted only after bidding has closed.")
            if bac.open_resolution(project) is not None:
                return _bad("This procurement already has an open resolution.")
            lcrb_id = bac.ranking(project)["lcrb_id"]
            if lcrb_id is None:
                return _bad("No bid has passed evaluation and post-qualification yet, so there is "
                            "nothing to recommend.")
            lcrb = Bid.objects.get(pk=lcrb_id)
            if any((r or {}).get("status") == "needs_revision" for r in (lcrb.document_reviews or {}).values()):
                # The award would refuse it (BidViewSet._check_can_award), so
                # don't let the members vote on a recommendation that can't be approved.
                return _bad("The recommended bid still has documents the committee flagged for revision. "
                            "Wait for the bidder to resubmit them.")
            res = BACResolution.objects.create(
                project=project, recommended_bid_id=lcrb_id, number=bac.next_resolution_number(project),
                meeting_date=meeting_date, meeting_mode=mode, venue=(data.get("venue") or "").strip()[:200],
                justification=justification, minutes=minutes, prepared_by=request.user)
        log_action(request, "bac.resolution_drafted", entity_type="BACResolution", entity_id=res.pk,
                   description=f"Drafted {res.number} recommending {res.recommended_bid.supplier.company}.")
        return Response(self.get_serializer(res).data, status=http_status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def discard(self, request, pk=None):
        """Delete a DRAFT nobody has voted on (a typo in the date or the basis)."""
        res = self.get_object()
        if res.status != BACResolution.Status.DRAFT:
            return _bad("Only a draft can be discarded. Once voting opens, the resolution is kept.")
        number = res.number
        res.delete()
        log_action(request, "bac.resolution_discarded", entity_type="BACResolution", entity_id=pk,
                   description=f"Discarded draft {number}.")
        return Response(status=http_status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="open-voting")
    def open_voting(self, request, pk=None):
        off = _workflow_off()
        if off:
            return off
        with transaction.atomic():
            res = BACResolution.objects.select_for_update().filter(pk=pk).first()
            if res is None:
                return _bad("Resolution not found.", http_status.HTTP_404_NOT_FOUND)
            if res.status != BACResolution.Status.DRAFT:
                return _bad("Voting is already open or finished on this resolution.")
            if bac.active_members().count() < BACMembership.MAJORITY:
                return _bad(f"At least {BACMembership.MAJORITY} active BAC members are needed to vote.")
            res.status = BACResolution.Status.VOTING
            res.voting_opened_at = timezone.now()
            res.save(update_fields=["status", "voting_opened_at"])
        notify_bac_members(f"Your vote is needed on {res.number} ({res.project.code}).", link="/bac/resolutions")
        log_action(request, "bac.voting_opened", entity_type="BACResolution", entity_id=res.pk,
                   description=f"Opened voting on {res.number}.")
        return Response(self.get_serializer(res).data)

    @action(detail=True, methods=["post"])
    def vote(self, request, pk=None):
        """POST {choice: approve|disapprove|abstain, comment}. Once per member, never edited."""
        off = _workflow_off()
        if off:
            return off
        seat = bac.membership_for(request.user)
        if seat is None:
            return _bad("You don't hold an active seat on the BAC Committee.", http_status.HTTP_403_FORBIDDEN)
        return self._cast(request, pk, seat, recorded_by=None)

    @action(detail=True, methods=["post"], url_path="record-vote")
    def record_vote(self, request, pk=None):
        """POST {member, choice, comment}. Staff enter a vote a member gave at
        an in-person meeting, from the ballot or the minutes. Only on a
        resolution whose meeting was in person. The vote keeps the member's
        name and says Staff recorded it, and the member is told, so a vote
        they didn't give can't pass unnoticed. Same rules as a member's own
        vote: once per member, never edited."""
        off = _workflow_off()
        if off:
            return off
        seat = BACMembership.objects.select_related("user").filter(
            pk=request.data.get("member") or 0, active=True).first()
        if seat is None:
            return _bad("Choose a member who holds an active seat on the committee.")
        return self._cast(request, pk, seat, recorded_by=request.user)

    def _cast(self, request, pk, seat, recorded_by):
        """Record one vote for `seat`: by the member (recorded_by None) or by
        Staff from an in-person meeting. Then adopt or fail the resolution if
        the votes are in (bac.decide_if_ready)."""
        choice = (request.data.get("choice") or "").strip()
        comment = (request.data.get("comment") or "").strip()
        in_person = recorded_by is not None
        if choice not in BACVote.Choice.values:
            return _bad("Choose Approve, Disapprove or Abstain.")
        if len(comment) < 10:
            return _bad("Write the member's reason as given at the meeting (at least 10 characters)." if in_person
                        else "Write the reason for your vote (at least 10 characters). It is kept "
                             "permanently in the BAC Records.")
        with transaction.atomic():
            res = BACResolution.objects.select_for_update().select_related("project").filter(pk=pk).first()
            if res is None:
                return _bad("Resolution not found.", http_status.HTTP_404_NOT_FOUND)
            if res.status != BACResolution.Status.VOTING:
                return _bad("This resolution isn't open for voting.")
            if in_person and res.meeting_mode != BACResolution.MeetingMode.IN_PERSON:
                return _bad("This resolution's meeting was held online, so each member votes from "
                            "their own account.")
            if res.votes.filter(member=seat).exists():
                return _bad(f"{_person(seat.user)} has already voted on this resolution. A vote can't "
                            f"be changed; add a correction note instead." if in_person
                            else "You have already voted on this resolution. A vote can't be changed.")
            vote = BACVote.objects.create(
                resolution=res, member=seat, voter_name=_person(seat.user)[:150], voter_position=seat.position,
                choice=choice, comment=comment,
                source=BACVote.Source.IN_PERSON if in_person else BACVote.Source.ONLINE,
                recorded_by=recorded_by, recorded_by_name=_person(recorded_by)[:150] if in_person else "")
            outcome = bac.decide_if_ready(res)
        if in_person:
            log_action(request, "bac.vote_recorded", entity_type="BACResolution", entity_id=res.pk,
                       description=f"{_person(recorded_by)} recorded {_person(seat.user)}'s in-person vote "
                                   f"({seat.get_position_display()}): {choice} on {res.number}.")
            from .notifications import notify_users  # noqa: PLC0415
            notify_users([seat.user], f"{_person(recorded_by)} recorded your in-person vote on {res.number}: "
                                      f"{vote.get_choice_display()}. If that is not what you voted, add a "
                                      f"correction note in the BAC Records.", link="/bac/records")
        else:
            log_action(request, "bac.vote_cast", entity_type="BACResolution", entity_id=res.pk,
                       description=f"{_person(request.user)} ({seat.get_position_display()}) voted {choice} "
                                   f"on {res.number}.")
        if outcome == BACResolution.Status.ADOPTED:
            notify_heads(f"{res.number} was adopted. The award of {res.project.code} awaits your approval.",
                         link="/head/awards")
            notify_staff(f"{res.number} was adopted and sent to the Head.", link="/staff/bac-meetings")
            log_action(request, "bac.resolution_adopted", entity_type="BACResolution", entity_id=res.pk,
                       description=f"{res.number} adopted; PDF frozen (SHA-256 {res.resolution_sha256[:16]}...).")
        elif outcome == BACResolution.Status.NOT_ADOPTED:
            notify_staff(f"{res.number} was not adopted by the committee.", link="/staff/bac-meetings")
            log_action(request, "bac.resolution_not_adopted", entity_type="BACResolution", entity_id=res.pk,
                       description=f"{res.number} was not adopted.")
        res.refresh_from_db()
        return Response(self.get_serializer(res).data, status=http_status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        """The Head approves the recommended award. Runs the original award code
        (BidViewSet._check_can_award / _award / _announce_award) under the same
        project row lock and writes the same three anchors, in the same order."""
        off = _workflow_off()
        if off:
            return off
        from .serializers import BidSerializer  # noqa: PLC0415
        from .views import BidViewSet  # noqa: PLC0415 - views.py imports bac.py, so import late

        awarder = BidViewSet()
        with transaction.atomic():
            res = BACResolution.objects.select_for_update().filter(pk=pk).first()
            if res is None:
                return _bad("Resolution not found.", http_status.HTTP_404_NOT_FOUND)
            if res.status != BACResolution.Status.ADOPTED or res.head_decision != BACResolution.HeadDecision.PENDING:
                return _bad("Only an adopted resolution waiting for your decision can be approved.")
            project = Project.objects.select_for_update().get(pk=res.project_id)
            bid = Bid.objects.select_for_update().get(pk=res.recommended_bid_id)
            bid.project, bid.supplier = project, bid.supplier
            refusal = awarder._check_can_award(bid, project)
            if refusal:
                return refusal
            award = BidViewSet._award(bid, project)
            res.head_decision = BACResolution.HeadDecision.APPROVED
            res.head_remarks = (request.data.get("remarks") or "").strip()
            res.head_decided_by = request.user
            res.head_decided_at = timezone.now()
            res.save(update_fields=["head_decision", "head_remarks", "head_decided_by", "head_decided_at"])

        BidViewSet._announce_award(request, bid, project)
        log_action(request, "bac.award_approved", entity_type="BACResolution", entity_id=res.pk,
                   description=f"Head approved {res.number}: {project.code} awarded to {bid.supplier.company}.")
        notify_staff(f"The Head approved the award of {project.code}. Issue the BAC Resolution, NOA and NTP.",
                     link="/staff/awards")
        notify_bac_members(f"The Head approved {res.number}; {project.code} is awarded.", link="/bac/records")
        # The same anchors as select_winner, in the same order: the evaluation
        # commitment, the winning bid, then the award.
        evaluation_anchor = anchor_evaluation(project)
        bid_anchor = anchor_bid(bid, BlockchainAnchor.Stage.BID_SUBMITTED)
        award_anchor = anchor_award(award)
        data = dict(self.get_serializer(res).data)
        data["bid"] = BidSerializer(bid, context={"request": request}).data
        data["award_id"] = award.id
        data["anchor"] = anchor_summary(award_anchor)
        data["anchor_sequence"] = [
            anchor_summary(a) for a in (evaluation_anchor, bid_anchor, award_anchor) if a is not None
        ]
        return Response(data)

    @action(detail=True, methods=["post"], url_path="return")
    def return_to_bac(self, request, pk=None):
        """POST {remarks}. The Head sends the recommendation back; the committee
        can re-evaluate and Staff can draft a new resolution. Kept as history."""
        off = _workflow_off()
        if off:
            return off
        remarks = (request.data.get("remarks") or "").strip()
        if len(remarks) < 10:
            return _bad("Explain why you are returning the recommendation (at least 10 characters).")
        with transaction.atomic():
            res = BACResolution.objects.select_for_update().select_related("project").filter(pk=pk).first()
            if res is None:
                return _bad("Resolution not found.", http_status.HTTP_404_NOT_FOUND)
            if res.status != BACResolution.Status.ADOPTED or res.head_decision != BACResolution.HeadDecision.PENDING:
                return _bad("Only an adopted resolution waiting for your decision can be returned.")
            res.status = BACResolution.Status.RETURNED
            res.head_decision = BACResolution.HeadDecision.RETURNED
            res.head_remarks = remarks
            res.head_decided_by = request.user
            res.head_decided_at = timezone.now()
            res.save(update_fields=["status", "head_decision", "head_remarks", "head_decided_by", "head_decided_at"])
        log_action(request, "bac.award_returned", entity_type="BACResolution", entity_id=res.pk,
                   description=f"Head returned {res.number} to the BAC Committee.")
        notify_staff(f"The Head returned {res.number}: {remarks[:120]}", link="/staff/bac-meetings")
        notify_bac_members(f"The Head returned {res.number} to the committee.", link="/bac/evaluation")
        return Response(self.get_serializer(res).data)


class VoteNoteView(APIView):
    """POST {note} - a correction note on a cast vote.

    The vote and the count never change: if the choice itself was recorded
    wrongly, the note says so on the record, and the remedy is the Head
    returning the resolution so the committee votes again. Added by the member
    whose vote it is (even after leaving the committee) or by Staff, who enter
    in-person votes. Write-once."""

    permission_classes = [IsInternalRole]

    def post(self, request, pk):
        off = _workflow_off()
        if off:
            return off
        vote = BACVote.objects.select_related("member__user", "resolution").filter(pk=pk).first()
        if vote is None:
            return _bad("Vote not found.", http_status.HTTP_404_NOT_FOUND)
        is_voter = vote.member.user_id == request.user.id
        if not (is_voter or request.user.role == "staff"):
            return _bad("Only the member who voted, or Procurement Staff, can add a correction note.",
                        http_status.HTTP_403_FORBIDDEN)
        text = (request.data.get("note") or "").strip()
        if len(text) < 10:
            return _bad("Write what needs correcting (at least 10 characters).")
        if len(text) > 1000:
            return _bad("Keep the note under 1,000 characters.")
        note = BACVoteNote.objects.create(
            vote=vote, note=text, author=request.user, author_name=_person(request.user)[:150],
            author_role=request.user.get_role_display()[:20])
        res = vote.resolution
        log_action(request, "bac.vote_note_added", entity_type="BACResolution", entity_id=res.pk,
                   description=f"{_person(request.user)} added a correction note to {vote.voter_name}'s "
                               f"vote on {res.number}.")
        if not is_voter:
            from .notifications import notify_users  # noqa: PLC0415
            notify_users([vote.member.user], f"{_person(request.user)} added a correction note to your vote on "
                                             f"{res.number}.", link="/bac/records")
        return Response(VoteNoteSerializer(note).data, status=http_status.HTTP_201_CREATED)
