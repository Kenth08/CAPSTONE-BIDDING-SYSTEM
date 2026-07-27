from django.urls import path
from rest_framework.routers import DefaultRouter

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
    # Public blockchain trail for one procurement code — no login, no wallet.
    path(
        "public/procurement/<str:code>/anchors/",
        PublicAnchorTrailView.as_view(),
        name="public-procurement-anchors",
    ),
] + router.urls
