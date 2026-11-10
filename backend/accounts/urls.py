from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from .idempotency import RequestOutcomeView
from .views import (
    AdminAssistedSupplierRegisterView,
    ChangePasswordView,
    EmailVerifyConfirmView,
    LoginView,
    LogoutView,
    MfaSetupView,
    MfaVerifyView,
    MeView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    ResendVerificationEmailView,
    SupplierRegisterView,
    UnlockAccountView,
)

urlpatterns = [
    path("login/", LoginView.as_view(), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("mfa/setup/", MfaSetupView.as_view(), name="mfa-setup"),
    path("mfa/verify/", MfaVerifyView.as_view(), name="mfa-verify"),
    path("register/supplier/", SupplierRegisterView.as_view(), name="register-supplier"),
    path("admin/register-supplier/", AdminAssistedSupplierRegisterView.as_view(), name="admin-register-supplier"),
    path("refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("me/", MeView.as_view(), name="me"),
    path("password/change/", ChangePasswordView.as_view(), name="change-password"),
    path("password/reset/", PasswordResetRequestView.as_view(), name="password-reset"),
    path("password/reset/confirm/", PasswordResetConfirmView.as_view(), name="password-reset-confirm"),
    path("verify-email/confirm/", EmailVerifyConfirmView.as_view(), name="verify-email-confirm"),
    path("verify-email/resend/", ResendVerificationEmailView.as_view(), name="verify-email-resend"),
    path("users/<int:pk>/unlock/", UnlockAccountView.as_view(), name="unlock-account"),
    path("requests/<str:key>/", RequestOutcomeView.as_view(), name="request-outcome"),
]
