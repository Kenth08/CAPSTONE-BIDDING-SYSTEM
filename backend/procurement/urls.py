from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    AwardViewSet,
    BidViewSet,
    DocumentViewSet,
    NotificationViewSet,
    ProjectViewSet,
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
] + router.urls
