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

User = get_user_model()


class LoginView(TokenObtainPairView):
    """POST {username, password} -> {access, refresh, user}."""

    serializer_class = RoleTokenObtainPairSerializer


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
