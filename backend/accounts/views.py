import logging

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.core.mail import send_mail
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework import generics, permissions, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from procurement.permissions import IsAdminRole

from .serializers import (
    ChangePasswordSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    RoleTokenObtainPairSerializer,
    SupplierRegisterSerializer,
    UserSerializer,
)
from .throttling import LoginRateThrottle, PasswordResetRateThrottle, RegisterRateThrottle

User = get_user_model()
logger = logging.getLogger(__name__)


class LoginView(TokenObtainPairView):
    """POST {username, password} -> {access, refresh, user}.

    Rate limited to 5 attempts per 15 minutes per IP to resist brute-force and
    credential-stuffing attacks (overrides the global default throttle)."""

    serializer_class = RoleTokenObtainPairSerializer
    throttle_classes = [LoginRateThrottle]


class RegisterView(generics.CreateAPIView):
    """POST to create a new account (used by supplier registration).

    Rate limited to 10 per hour per IP — stops scripted mass account creation
    without affecting a real applicant fixing a typo or validation error."""

    queryset = User.objects.all()
    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]
    throttle_classes = [RegisterRateThrottle]


class SupplierRegisterView(generics.CreateAPIView):
    """POST multipart form -> creates a supplier account + profile (pending review).

    Same per-IP rate limit as RegisterView, for the same reason."""

    queryset = User.objects.all()
    serializer_class = SupplierRegisterSerializer
    permission_classes = [permissions.AllowAny]
    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [RegisterRateThrottle]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response(
            {"detail": "Registration submitted. Your account is pending admin verification."},
            status=201,
        )


class AdminAssistedSupplierRegisterView(generics.CreateAPIView):
    """POST multipart form -> an Admin registers a supplier on their behalf
    (e.g. the supplier walked into the office with physical documents that
    were scanned/photographed). Goes through the exact same serializer and
    verification gate as self-registration — only who submits the form
    differs, not the resulting record or approval pipeline."""

    queryset = User.objects.all()
    serializer_class = SupplierRegisterSerializer
    permission_classes = [IsAdminRole]
    parser_classes = [MultiPartParser, FormParser]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        return Response(
            {"detail": "Supplier registered. Their account is pending admin verification."},
            status=201,
        )


class MeView(APIView):
    """GET the currently authenticated user."""

    def get(self, request):
        return Response(UserSerializer(request.user).data)


class ChangePasswordView(APIView):
    """POST {current_password, new_password} -> changes the caller's own password."""

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response({"detail": "Password changed successfully."})


class PasswordResetRequestView(APIView):
    """POST {email} -> emails a one-time reset link if that address has an account.

    Always returns the same generic response whether or not the email matches
    an account, and never lets an SMTP failure surface to the caller — both on
    purpose, so this endpoint can't be used to enumerate registered emails or
    be broken by a misconfigured mail server."""

    permission_classes = [permissions.AllowAny]
    throttle_classes = [PasswordResetRateThrottle]

    GENERIC_RESPONSE = {"detail": "If an account exists for that email, a password reset link has been sent."}

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]

        user = User.objects.filter(email__iexact=email, is_active=True).first()
        if user:
            uid = urlsafe_base64_encode(force_bytes(user.pk))
            token = default_token_generator.make_token(user)
            frontend = (settings.FRONTEND_URL or "http://localhost:3000").rstrip("/")
            link = f"{frontend}/reset-password?uid={uid}&token={token}"
            try:
                send_mail(
                    subject="Reset your E-Procurement password",
                    message=(
                        f"Hi {user.full_name or user.username},\n\n"
                        "We received a request to reset your password. This link is valid "
                        "for 3 days and can only be used once:\n\n"
                        f"{link}\n\n"
                        "If you didn't request this, you can safely ignore this email."
                    ),
                    from_email=settings.DEFAULT_FROM_EMAIL,
                    recipient_list=[user.email],
                    fail_silently=True,
                )
            except Exception:
                # Never let an email/SMTP problem surface to the caller or
                # change the response — log it and move on.
                logger.exception("Failed to send password reset email")

        return Response(self.GENERIC_RESPONSE)


class PasswordResetConfirmView(APIView):
    """POST {uid, token, new_password} -> sets a new password.

    The token is Django's stateless PasswordResetTokenGenerator: it embeds the
    user's pk, password hash and a timestamp, so it expires on its own
    (PASSWORD_RESET_TIMEOUT, 3 days by default) and is invalidated the moment
    the password actually changes — no extra database table or cleanup job."""

    permission_classes = [permissions.AllowAny]
    throttle_classes = [PasswordResetRateThrottle]

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response({"detail": "Your password has been reset. You can now log in."})


class LogoutView(APIView):
    """POST {refresh} -> blacklists that refresh token so it can't be used again.

    AllowAny because the refresh token itself (not a still-valid access token)
    is the credential proving the caller may invalidate it — this lets logout
    work even if the access token already expired. A missing/invalid/already
    expired token is treated as "already logged out" rather than an error, so
    the frontend's logout button never has to handle a failure case."""

    permission_classes = [permissions.AllowAny]

    def post(self, request):
        refresh = request.data.get("refresh")
        if refresh:
            try:
                RefreshToken(refresh).blacklist()
            except TokenError:
                pass
        return Response(status=status.HTTP_205_RESET_CONTENT)
