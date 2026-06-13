from django.contrib.auth import get_user_model
from rest_framework import generics, permissions
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView

from .serializers import (
    RegisterSerializer,
    RoleTokenObtainPairSerializer,
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


class MeView(APIView):
    """GET the currently authenticated user."""

    def get(self, request):
        return Response(UserSerializer(request.user).data)
