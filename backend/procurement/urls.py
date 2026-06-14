from rest_framework.routers import DefaultRouter

from .views import (
    AwardViewSet,
    BidViewSet,
    DocumentViewSet,
    NotificationViewSet,
    ProjectViewSet,
    SupplierViewSet,
)

router = DefaultRouter()
router.register(r"projects", ProjectViewSet)
router.register(r"suppliers", SupplierViewSet)
router.register(r"bids", BidViewSet)
router.register(r"awards", AwardViewSet)
router.register(r"documents", DocumentViewSet)
router.register(r"notifications", NotificationViewSet, basename="notification")

urlpatterns = router.urls
