"""BAC Committee rules for the separation-of-duties workflow
(settings.BAC_WORKFLOW_ENABLED, docs/BAC_ROLES_PLAN.md).

Pure decisions live here; the endpoints that call them are in bac_views.py.

    bidding closes ─► every active member evaluates every bid
                      (majority of BACMembership.MAJORITY decides qualified / disqualified)
                 ─► ranking: qualified bids, lowest amount first (computed, never stored)
                 ─► Chairperson records post-qualification of the top candidate
                      (failed → the next bid becomes the candidate)
                 ─► Staff drafts a resolution for the bid that passed, opens voting
                 ─► members vote with a comment; MAJORITY approvals adopt it and
                      the PDF is generated and frozen
                 ─► the Head approves the award (the original award code runs)
                      or returns it, and a new resolution starts

Nothing here writes to the blockchain. The award anchors are the same three as
before (EVALUATION_COMPLETED, BID_SUBMITTED, AWARDED), and the frozen resolution
file is what the existing RESOLUTION_ISSUED anchor fingerprints later.
"""
import hashlib

from django.core.files.base import ContentFile
from django.utils import timezone

from .documents import build_committee_resolution
from .models import BACMembership, BACResolution, BACVote, Bid, BidPostQualification, Project

MAJORITY = BACMembership.MAJORITY


def active_members():
    return BACMembership.objects.filter(active=True).select_related("user")


def membership_for(user):
    """The caller's active seat on the committee, or None."""
    if not (user and user.is_authenticated) or getattr(user, "role", None) != "bac":
        return None
    return BACMembership.objects.filter(user=user, active=True).first()


def bidding_closed(project):
    """Bids stay sealed until the deadline: evaluation starts only after it."""
    if project.status == Project.Status.CLOSED:
        return True
    return (project.status == Project.Status.PUBLISHED and project.deadline is not None
            and project.deadline < timezone.localdate())


def open_resolution(project):
    return project.bac_resolutions.filter(status__in=BACResolution.OPEN_STATUSES).first()


def evaluation_lock_reason(project):
    """Why evaluations and post-qualification can't change now, or None."""
    if project.status == Project.Status.AWARDED:
        return "This procurement has already been awarded, so its evaluation is final."
    if not bidding_closed(project):
        return "Bids can be evaluated only after the bidding deadline has passed."
    res = open_resolution(project)
    if res is not None and res.status != BACResolution.Status.DRAFT:
        return ("A resolution for this procurement is being voted on or has been adopted, "
                "so the evaluation is fixed. It reopens only if the Head returns the award.")
    return None


# ── Evaluation and majority ──────────────────────────────────────────────────

def tally(bid):
    evaluations = list(bid.evaluations.all())
    passed = sum(1 for e in evaluations if e.passed)
    return {"passed": passed, "failed": len(evaluations) - passed, "count": len(evaluations)}


def failed_post_qualification(bid):
    return BidPostQualification.objects.filter(
        bid=bid, result=BidPostQualification.Result.FAILED).exists()


def majority_status(bid):
    """The bid status the evaluations add up to. A bid that failed
    post-qualification stays disqualified whatever the evaluations say."""
    t = tally(bid)
    if failed_post_qualification(bid):
        return Bid.Status.DISQUALIFIED
    if t["passed"] >= MAJORITY:
        return Bid.Status.QUALIFIED
    if t["failed"] >= MAJORITY:
        return Bid.Status.DISQUALIFIED
    return Bid.Status.UNDER_REVIEW


def apply_majority(bid):
    """Set the bid's status from the evaluations. Returns (old, new). A winning
    bid is never touched (the award has fixed it)."""
    old = bid.status
    if old == Bid.Status.WINNER:
        return old, old
    new = majority_status(bid)
    if new != old:
        bid.status = new
        bid.reviewed_at = timezone.now()
        bid.save(update_fields=["status", "reviewed_at"])
    return old, new


# ── Ranking and post-qualification ───────────────────────────────────────────

def ranking(project):
    """The bids a majority of members passed, lowest amount first (ties:
    earliest submitted). A bid that later failed post-qualification stays in
    the list, marked, so the record shows why the next bid moved up.

    candidate: the first bid not failed in post-qualification, which is the one
    the Chairperson post-qualifies next. lcrb: that bid once it has passed
    (Lowest Calculated Responsive Bid), the only bid a resolution may name."""
    bids = [b for b in (project.bids.select_related("supplier").prefetch_related("evaluations")
                        .order_by("amount", "submitted_at", "id"))
            if b.status == Bid.Status.WINNER or tally(b)["passed"] >= MAJORITY]
    pqs = {pq.bid_id: pq for pq in BidPostQualification.objects.filter(bid__project=project)}
    rows, candidate_id, lcrb_id = [], None, None
    for rank, bid in enumerate(bids, start=1):
        pq = pqs.get(bid.id)
        if candidate_id is None and (pq is None or pq.result == BidPostQualification.Result.PASSED):
            candidate_id = bid.id
            if pq is not None:
                lcrb_id = bid.id
        t = tally(bid)
        rows.append({
            "rank": rank,
            "bid_id": bid.id,
            "company": bid.supplier.company,
            "amount": str(bid.amount),
            "evaluations_passed": t["passed"],
            "evaluations_count": t["count"],
            "post_qualification": pq.get_result_display() if pq else "",
            "post_qualification_remarks": pq.remarks if pq else "",
        })
    return {"rows": rows, "candidate_id": candidate_id, "lcrb_id": lcrb_id}


# ── Resolutions and votes ────────────────────────────────────────────────────

def next_resolution_number(project):
    n = project.bac_resolutions.count() + 1
    return f"BAC-RES-{project.code}-{n}"


def vote_counts(resolution):
    counts = {c: 0 for c in BACVote.Choice.values}
    for v in resolution.votes.all():
        counts[v.choice] += 1
    return counts


def decide_if_ready(resolution):
    """After a vote: adopt on MAJORITY approvals, fail on MAJORITY disapprovals
    or once every active member has voted without a majority. Freezes the PDF
    on adoption. Returns the new status, or None if voting continues."""
    counts = vote_counts(resolution)
    now = timezone.now()
    if counts["approve"] >= MAJORITY:
        resolution.status = BACResolution.Status.ADOPTED
        resolution.decided_at = now
        freeze_resolution_pdf(resolution, now)
        resolution.save(update_fields=["status", "decided_at", "resolution_file", "resolution_sha256"])
        return resolution.status
    if counts["disapprove"] >= MAJORITY or sum(counts.values()) >= active_members().count():
        resolution.status = BACResolution.Status.NOT_ADOPTED
        resolution.decided_at = now
        resolution.save(update_fields=["status", "decided_at"])
        return resolution.status
    return None


def freeze_resolution_pdf(resolution, decided_at):
    """Write the adopted resolution's PDF once and record its SHA-256. Never
    called again for the same resolution: regenerating would change the bytes."""
    if resolution.resolution_file:
        return
    pdf = build_committee_resolution(resolution, ranking(resolution.project)["rows"], decided_at)
    resolution.resolution_sha256 = hashlib.sha256(pdf).hexdigest()
    resolution.resolution_file = ContentFile(pdf, name=f"{resolution.number}.pdf")


def frozen_resolution_bytes(project):
    """The adopted, Head-approved resolution's stored bytes for this project,
    or None. Used when Staff issue the award's BAC Resolution document."""
    res = project.bac_resolutions.filter(
        status=BACResolution.Status.ADOPTED, head_decision=BACResolution.HeadDecision.APPROVED,
    ).exclude(resolution_file="").first()
    if res is None or not res.resolution_file:
        return None
    with res.resolution_file.open("rb") as fh:
        data = fh.read()
    if hashlib.sha256(data).hexdigest() != res.resolution_sha256:
        # The stored file no longer matches what the members adopted. Refuse
        # rather than issue (and anchor) a document nobody voted on.
        raise ValueError(f"The stored file of {res.number} does not match its recorded fingerprint.")
    return data
