from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Custom user with a procurement role.

    The frontend currently stores `localStorage.role` as one of
    admin / head / supplier. This replaces that with a real account.
    """

    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        HEAD = "head", "Head"
        SUPPLIER = "supplier", "Supplier"

    role = models.CharField(max_length=20, choices=Role.choices, default=Role.SUPPLIER)
    full_name = models.CharField(max_length=150, blank=True)

    def __str__(self):
        return f"{self.username} ({self.role})"
