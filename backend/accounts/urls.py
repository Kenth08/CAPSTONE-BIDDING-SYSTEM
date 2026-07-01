from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from .views import (
    AdminAssistedSupplierRegisterView,
    ChangePasswordView,
    EmailVerifyConfirmView,
    LoginView,
    LogoutView,
    MeView,
    MFAConfirmView,
    MFADisableView,
    MFAEnableView,
    MFASendCodeView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    RegisterView,
    ResendVerificationEmailView,
    SupplierRegisterView,
)

urlpatterns = [
    path("login/", LoginView.as_view(), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("register/", RegisterView.as_view(), name="register"),
    path("register/supplier/", SupplierRegisterView.as_view(), name="register-supplier"),
    path("admin/register-supplier/", AdminAssistedSupplierRegisterView.as_view(), name="admin-register-supplier"),
    path("refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("me/", MeView.as_view(), name="me"),
    path("password/change/", ChangePasswordView.as_view(), name="change-password"),
    path("password/reset/", PasswordResetRequestView.as_view(), name="password-reset"),
    path("password/reset/confirm/", PasswordResetConfirmView.as_view(), name="password-reset-confirm"),
    path("verify-email/confirm/", EmailVerifyConfirmView.as_view(), name="verify-email-confirm"),
    path("verify-email/resend/", ResendVerificationEmailView.as_view(), name="verify-email-resend"),
    # MFA (admin/head only)
    path("mfa/confirm/", MFAConfirmView.as_view(), name="mfa-confirm"),
    path("mfa/send-code/", MFASendCodeView.as_view(), name="mfa-send-code"),
    path("mfa/enable/", MFAEnableView.as_view(), name="mfa-enable"),
    path("mfa/disable/", MFADisableView.as_view(), name="mfa-disable"),
]
