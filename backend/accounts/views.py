from django.contrib.auth import get_user_model
from rest_framework import generics, permissions, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from .serializers import (
    RegisterSerializer,
    RoleTokenObtainPairSerializer,
    SupplierRegisterSerializer,
    UserSerializer,
)
from .throttling import LoginRateThrottle, RegisterRateThrottle

User = get_user_model()


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


class MeView(APIView):
    """GET the currently authenticated user."""

    def get(self, request):
        return Response(UserSerializer(request.user).data)


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
