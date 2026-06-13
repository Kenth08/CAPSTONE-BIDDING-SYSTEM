from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from procurement.models import Supplier

User = get_user_model()

# Documents the supplier must upload to register (the optional ones are excluded).
REQUIRED_DOCUMENTS = [
    "sec_dti_certificate", "mayors_permit", "philgeps_certificate", "valid_id",
    "tax_clearance_certificate", "audited_financial_statements",
    "bank_reference_letter", "authorization_letter",
]


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "email", "role", "full_name"]


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=6)

    class Meta:
        model = User
        fields = ["id", "username", "email", "password", "role", "full_name"]

    def create(self, validated_data):
        password = validated_data.pop("password")
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        return user


class SupplierRegisterSerializer(serializers.ModelSerializer):
    """Creates a supplier User + Supplier profile from the multi-step form.

    Receives multipart/form-data (account fields + company details + document
    files). Enforces strong passwords, basic input validation, and starts the
    account in 'waiting admin approval' (the verification gate).
    """

    # Account fields (live on User, not the Supplier profile)
    full_name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    confirm_password = serializers.CharField(write_only=True)
    # The model field is `company`; the form sends `company_name`.
    company_name = serializers.CharField(source="company")
    # Sent from the browser as a JSON string in a multipart form.
    business_types = serializers.JSONField()

    class Meta:
        model = Supplier
        fields = [
            # account
            "full_name", "email", "password", "confirm_password",
            # company details
            "company_name", "company_address", "phone_number", "tin",
            "representative_name", "business_types",
            # legal docs
            "sec_dti_certificate", "mayors_permit", "philgeps_certificate",
            "valid_id", "mayors_permit_expiry",
            # financial docs
            "tax_clearance_certificate", "audited_financial_statements",
            "bank_reference_letter", "tax_clearance_expiry",
            "financial_statement_year",
            # authorization
            "authorization_letter",
            # optional qualifications
            "performance_certificates", "past_contracts",
            "track_record_description",
            # declaration
            "declaration_accepted",
        ]
        # Documents are blank/null on the model (so admins can add bare suppliers),
        # but they are mandatory when self-registering.
        extra_kwargs = {name: {"required": True, "allow_null": False} for name in REQUIRED_DOCUMENTS}

    def validate_email(self, value):
        if User.objects.filter(username=value).exists() or User.objects.filter(email=value).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value

    def validate_phone_number(self, value):
        if not value.isdigit():
            raise serializers.ValidationError("Phone number must contain digits only.")
        return value

    def validate_tin(self, value):
        if not value.replace("-", "").isdigit():
            raise serializers.ValidationError("TIN must contain digits only.")
        return value

    def validate_declaration_accepted(self, value):
        if not value:
            raise serializers.ValidationError("You must accept the declaration to register.")
        return value

    def validate(self, attrs):
        if attrs["password"] != attrs.pop("confirm_password"):
            raise serializers.ValidationError({"confirm_password": "Passwords do not match."})
        # Run Django's configured password-strength validators.
        try:
            validate_password(attrs["password"])
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"password": list(exc.messages)})
        return attrs

    def create(self, validated_data):
        email = validated_data.pop("email")
        password = validated_data.pop("password")
        full_name = validated_data.pop("full_name")

        user = User(
            username=email,
            email=email,
            full_name=full_name,
            role=User.Role.SUPPLIER,
        )
        user.set_password(password)
        user.save()

        # Fill the legacy fields the rest of the app already reads.
        validated_data["contact"] = validated_data.get("representative_name", "")
        validated_data["business_type"] = ", ".join(validated_data.get("business_types", []))
        return Supplier.objects.create(user=user, **validated_data)


class RoleTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Adds role + user info to the login response so the frontend can
    replace its localStorage 'role' hack with the real value."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"] = user.role
        return token

    def validate(self, attrs):
        data = super().validate(attrs)
        data["user"] = UserSerializer(self.user).data
        return data
