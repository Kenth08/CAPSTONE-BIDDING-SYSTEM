from django.contrib.auth import get_user_model
from rest_framework import generics, permissions
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView

from .serializers import (
    RegisterSerializer,
    RoleTokenObtainPairSerializer,
    SupplierRegisterSerializer,
    UserSerializer,
)
from .throttling import LoginRateThrottle

User = get_user_model()


class LoginView(TokenObtainPairView):
    """POST {username, password} -> {access, refresh, user}.

    Rate limited to 5 attempts per 15 minutes per IP to resist brute-force and
    credential-stuffing attacks (overrides the global default throttle)."""

    serializer_class = RoleTokenObtainPairSerializer
    throttle_classes = [LoginRateThrottle]


class RegisterView(generics.CreateAPIView):
    """POST to create a new account (used by supplier registration)."""

    queryset = User.objects.all()
    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]


class SupplierRegisterView(generics.CreateAPIView):
    """POST multipart form -> creates a supplier account + profile (pending review)."""

    queryset = User.objects.all()
    serializer_class = SupplierRegisterSerializer
    permission_classes = [permissions.AllowAny]
    parser_classes = [MultiPartParser, FormParser]

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
