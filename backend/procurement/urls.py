from django.urls import path
from rest_framework.routers import DefaultRouter

from .locations import LocationListView

from .bac_views import (
    BACStatusView,
    EvaluateBidView,
    EvaluationProjectDetailView,
    EvaluationProjectsView,
    MembershipViewSet,
    PostQualifyView,
    DemoCloseBiddingView,
    ResolutionViewSet,
    UpcomingEvaluationsView,
    VoteNoteView,
)
from .categories import CategoryView
from .dashboard import AdminSummaryView, HeadSummaryView, PublicSummaryView
from .files import ProtectedFileLinkView, ProtectedFileView, PublicNoticeOfAwardView
from .views import (
    AnchorNextPendingView,
    AwardViewSet,
    BidViewSet,
    DocumentViewSet,
    NotificationViewSet,
    ProjectViewSet,
    PublicAnchorDetailView,
    PublicAnchorPacketView,
    PublicAnchorTrailView,
    PublicProcurementDetailView,
    PublicProcurementView,
    SupplierViewSet,
)

router = DefaultRouter()
router.register(r"projects", ProjectViewSet)
router.register(r"suppliers", SupplierViewSet)
router.register(r"bids", BidViewSet)
router.register(r"awards", AwardViewSet)
router.register(r"documents", DocumentViewSet)
router.register(r"notifications", NotificationViewSet, basename="notification")
# BAC Committee workflow (procurement/bac_views.py).
router.register(r"bac/memberships", MembershipViewSet, basename="bac-membership")
router.register(r"bac/resolutions", ResolutionViewSet, basename="bac-resolution")

# Public, unauthenticated endpoint (declared before the router so it isn't
# shadowed by an authenticated route).
urlpatterns = [
    path("categories/", CategoryView.as_view(), name="categories"),
    path("public/procurement/", PublicProcurementView.as_view(), name="public-procurement"),
    # Read-only dashboard summaries (see procurement/dashboard.py).
    path("public/summary/", PublicSummaryView.as_view(), name="public-summary"),
    path("dashboard/admin-summary/", AdminSummaryView.as_view(), name="dashboard-admin-summary"),
    path("dashboard/head-summary/", HeadSummaryView.as_view(), name="dashboard-head-summary"),
    path("anchors/send-next/", AnchorNextPendingView.as_view(), name="anchors-send-next"),
    path("bac/status/", BACStatusView.as_view(), name="bac-status"),
    path("bac/projects/", EvaluationProjectsView.as_view(), name="bac-projects"),
    path("bac/projects/upcoming/", UpcomingEvaluationsView.as_view(), name="bac-projects-upcoming"),
    # DEMO ONLY, temporary (see DemoCloseBiddingView).
    path("bac/projects/<int:pk>/demo-close-bidding/", DemoCloseBiddingView.as_view(), name="bac-demo-close-bidding"),
    path("bac/projects/<int:pk>/", EvaluationProjectDetailView.as_view(), name="bac-project"),
    path("bac/bids/<int:pk>/evaluate/", EvaluateBidView.as_view(), name="bac-evaluate"),
    path("bac/bids/<int:pk>/post-qualify/", PostQualifyView.as_view(), name="bac-post-qualify"),
    path("bac/votes/<int:pk>/notes/", VoteNoteView.as_view(), name="bac-vote-notes"),
    # Philippine locations (PSGC) for address pickers - procurement/locations.py.
    path("locations/regions/", LocationListView.as_view(kind="regions"), name="loc-regions"),
    path("locations/regions/<str:code>/provinces/", LocationListView.as_view(kind="region-provinces"),
         name="loc-region-provinces"),
    path("locations/regions/<str:code>/cities/", LocationListView.as_view(kind="region-cities"),
         name="loc-region-cities"),
    path("locations/provinces/<str:code>/cities/", LocationListView.as_view(kind="province-cities"),
         name="loc-province-cities"),
    path("locations/cities/<str:code>/barangays/", LocationListView.as_view(kind="city-barangays"),
         name="loc-city-barangays"),
    # One procurement's public result (winner + date only) — no login.
    path(
        "public/procurement/<str:code>/",
        PublicProcurementDetailView.as_view(),
        name="public-procurement-detail",
    ),
    # Public blockchain trail for one procurement code — no login, no wallet.
    path(
        "public/procurement/<str:code>/anchors/",
        PublicAnchorTrailView.as_view(),
        name="public-procurement-anchors",
    ),
    # One record of a public procurement's trail in full (record details page).
    path(
        "public/procurement/<str:code>/anchors/<int:anchor_id>/",
        PublicAnchorDetailView.as_view(),
        name="public-procurement-anchor-detail",
    ),
    # One public anchor's verification packet (payload + hashing rules +
    # on-chain identity) — project stages only, see procurement/packets.py.
    path(
        "public/procurement/<str:code>/anchors/<int:anchor_id>/packet/",
        PublicAnchorPacketView.as_view(),
        name="public-procurement-anchor-packet",
    ),
    # Every uploaded document is served from here, never from MEDIA_URL — the
    # route exists in production (MEDIA_URL's does not) and it enforces who may
    # read what. See procurement/files.py.
    # The Notice of Award of an AWARDED procurement is public, so anyone can
    # hash it and compare it with its NOA_ISSUED anchor.
    path(
        "public/procurement/<str:code>/notice-of-award/",
        PublicNoticeOfAwardView.as_view(),
        name="public-notice-of-award",
    ),
    path(
        "files/<str:kind>/<int:pk>/<str:field>/",
        ProtectedFileView.as_view(),
        name="protected-file",
    ),
    # Mints a one-time, 2-minute download link for the signed-in caller.
    path(
        "files/<str:kind>/<int:pk>/<str:field>/link/",
        ProtectedFileLinkView.as_view(),
        name="protected-file-link",
    ),
] + router.urls
