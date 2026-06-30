from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Q
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from rest_framework import serializers
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from procurement.models import PROCUREMENT_CATEGORIES, Supplier

from .emails import email_verification_token, send_verification_email

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


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, max_length=128)

    def validate_current_password(self, value):
        if not self.context["request"].user.check_password(value):
            raise serializers.ValidationError("Your current password is incorrect.")
        return value

    def validate_new_password(self, value):
        try:
            validate_password(value, user=self.context["request"].user)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages))
        return value

    def save(self):
        user = self.context["request"].user
        user.set_password(self.validated_data["new_password"])
        user.save()
        return user


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, max_length=128)

    def validate(self, attrs):
        try:
            user = User.objects.get(pk=force_str(urlsafe_base64_decode(attrs["uid"])))
        except (TypeError, ValueError, OverflowError, User.DoesNotExist):
            raise serializers.ValidationError({"detail": "This password reset link is invalid."})

        if not default_token_generator.check_token(user, attrs["token"]):
            raise serializers.ValidationError(
                {"detail": "This password reset link is invalid or has expired."}
            )

        try:
            validate_password(attrs["new_password"], user=user)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"new_password": list(exc.messages)})

        attrs["user"] = user
        return attrs

    def save(self):
        user = self.validated_data["user"]
        user.set_password(self.validated_data["new_password"])
        user.save()
        return user


class RegisterSerializer(serializers.ModelSerializer):
    """Plain self-registration (currently unused by the frontend, which uses
    SupplierRegisterSerializer instead, but the route is public so it must be
    safe to call directly). `role` is read-only — every account created here
    gets the model default ('supplier'); without this, any caller could pass
    role=admin and grant themselves full admin access with no verification."""

    password = serializers.CharField(write_only=True, min_length=6, max_length=128)

    class Meta:
        model = User
        fields = ["id", "username", "email", "password", "role", "full_name"]
        read_only_fields = ["role"]

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
    # `create()` below also uses this value as the username, so it's capped at
    # 150 (AbstractUser.username's max_length) rather than email's usual 254 —
    # otherwise a long-but-valid email could pass this check yet still blow up
    # the DB insert (username/email are never full_clean()'d before save()).
    email = serializers.EmailField(max_length=150)
    password = serializers.CharField(write_only=True, max_length=128)
    confirm_password = serializers.CharField(write_only=True, max_length=128)
    # The model field is `company`; the form sends `company_name`.
    company_name = serializers.CharField(source="company", max_length=200)
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

    def validate_business_types(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError("Select at least one business category.")
        if len(value) > len(PROCUREMENT_CATEGORIES):
            raise serializers.ValidationError("Too many categories selected.")
        if not all(isinstance(item, str) for item in value):
            raise serializers.ValidationError("Invalid category list.")
        if not set(value).issubset(PROCUREMENT_CATEGORIES):
            raise serializers.ValidationError("Select only valid procurement categories.")
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
        supplier = Supplier.objects.create(user=user, **validated_data)
        send_verification_email(user)

        # Let the admins know a new supplier is waiting for verification.
        from procurement.notifications import notify_admins
        notify_admins(
            f"New supplier registration: {supplier.company} is waiting for approval.",
            link="/admin/suppliers",
        )
        return supplier


class EmailVerifyConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()

    def validate(self, attrs):
        try:
            user = User.objects.get(pk=force_str(urlsafe_base64_decode(attrs["uid"])))
        except (TypeError, ValueError, OverflowError, User.DoesNotExist):
            raise serializers.ValidationError({"detail": "This verification link is invalid."})

        if not email_verification_token.check_token(user, attrs["token"]):
            raise serializers.ValidationError(
                {"detail": "This verification link is invalid or has expired."}
            )

        attrs["user"] = user
        return attrs

    def save(self):
        user = self.validated_data["user"]
        supplier = Supplier.objects.filter(user=user).first()
        if supplier and not supplier.email_verified:
            supplier.email_verified = True
            supplier.save(update_fields=["email_verified"])
        return user


class RoleTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Single sign-in for every role.

    Users log in with EITHER their username OR their email (admins/heads can
    use their email saved in the database, suppliers already use their email as
    their username). The account's real role is returned so the frontend knows
    which dashboard to open — no role picker needed. Errors are specific so the
    user knows exactly what went wrong."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["role"] = user.role
        return token

    def validate(self, attrs):
        identifier = (attrs.get(self.username_field) or "").strip()
        password = attrs.get("password") or ""

        if not identifier or not password:
            raise serializers.ValidationError(
                {"detail": "Please enter both your username/email and your password."}
            )

        # Resolve an email to the matching account so login works either way.
        # One query (username OR email) instead of two sequential round-trips.
        user_obj = User.objects.filter(
            Q(username__iexact=identifier) | Q(email__iexact=identifier)
        ).first()
        if user_obj is None:
            raise serializers.ValidationError(
                {"detail": "No account found with that username or email. "
                           "Please register to create an account."}
            )
        if not user_obj.is_active:
            raise serializers.ValidationError(
                {"detail": "This account is inactive. Please contact the administrator."}
            )

        # Authenticate with the resolved username (SimpleJWT uses USERNAME_FIELD).
        attrs[self.username_field] = user_obj.get_username()
        try:
            data = super().validate(attrs)
        except AuthenticationFailed:
            raise serializers.ValidationError(
                {"detail": "Incorrect password. Please try again."}
            )

        data["user"] = UserSerializer(self.user).data
        return data
