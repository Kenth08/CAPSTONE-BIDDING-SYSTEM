from django.urls import path
from rest_framework.routers import DefaultRouter

from .dashboard import AdminSummaryView, HeadSummaryView, PublicSummaryView
from .files import ProtectedFileLinkView, ProtectedFileView, PublicNoticeOfAwardView
from .views import (
    AwardViewSet,
    BidViewSet,
    DocumentViewSet,
    NotificationViewSet,
    ProjectViewSet,
    PublicAnchorTrailView,
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

# Public, unauthenticated endpoint (declared before the router so it isn't
# shadowed by an authenticated route).
urlpatterns = [
    path("public/procurement/", PublicProcurementView.as_view(), name="public-procurement"),
    # Read-only dashboard summaries (see procurement/dashboard.py).
    path("public/summary/", PublicSummaryView.as_view(), name="public-summary"),
    path("dashboard/admin-summary/", AdminSummaryView.as_view(), name="dashboard-admin-summary"),
    path("dashboard/head-summary/", HeadSummaryView.as_view(), name="dashboard-head-summary"),
    # Public blockchain trail for one procurement code — no login, no wallet.
    path(
        "public/procurement/<str:code>/anchors/",
        PublicAnchorTrailView.as_view(),
        name="public-procurement-anchors",
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
