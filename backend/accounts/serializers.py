from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from rest_framework import serializers
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from procurement.document_requirements import (
    EXPIRY_SUFFIX, UPLOAD_PREFIX, category_requirements, validate_future_expiry,
)
from procurement.models import PROCUREMENT_CATEGORIES, Supplier, SupplierCategoryDocument
from procurement.validators import validate_upload

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
        user.password_changed_at = timezone.now()
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
        user.password_changed_at = timezone.now()
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

    def _not_expired(self, value, label):
        try:
            validate_future_expiry(value, label)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc))
        return value

    def validate_mayors_permit_expiry(self, value):
        return self._not_expired(value, "Mayor's / Business Permit")

    def validate_tax_clearance_expiry(self, value):
        return self._not_expired(value, "Tax Clearance Certificate")

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
        # Extra licenses the chosen categories require (document_requirements.py).
        # Kept off `attrs`: they become SupplierCategoryDocument rows, not
        # Supplier fields.
        self._category_uploads = self._validate_category_documents(attrs.get("business_types") or [])
        return attrs

    def _validate_category_documents(self, categories):
        """Check the catdoc_<key> files (and catdoc_<key>_expiry dates) for the
        chosen categories. Files for categories the supplier didn't pick are
        ignored. Returns [(requirement, file, expiry_date)] to save."""
        data = self.initial_data
        errors, uploads = {}, []
        date_field = serializers.DateField()
        for req in category_requirements(categories):
            field = f"{UPLOAD_PREFIX}{req['key']}"
            upload = data.get(field)
            if upload is not None and not hasattr(upload, "read"):
                upload = None   # a plain string, not a file
            raw_expiry = str(data.get(field + EXPIRY_SUFFIX) or "").strip()

            if upload is None:
                if req["required"]:
                    errors[field] = [f"{req['label']} is required for {req['category']}."]
                continue
            try:
                validate_upload(upload)
            except DjangoValidationError as exc:
                errors[field] = list(exc.messages)
                continue

            expiry = None
            if req["has_expiry"]:
                if not raw_expiry:
                    errors[field + EXPIRY_SUFFIX] = [f"Enter the expiry date of the {req['label']}."]
                    continue
                try:
                    expiry = date_field.to_internal_value(raw_expiry)
                    validate_future_expiry(expiry, req["label"])
                except serializers.ValidationError:
                    errors[field + EXPIRY_SUFFIX] = [f"Enter a valid expiry date for the {req['label']}."]
                    continue
                except ValueError as exc:
                    errors[field + EXPIRY_SUFFIX] = [str(exc)]
                    continue
            uploads.append((req, upload, expiry))
        if errors:
            raise serializers.ValidationError(errors)
        return uploads

    def create(self, validated_data):
        email = validated_data.pop("email")
        password = validated_data.pop("password")
        full_name = validated_data.pop("full_name")

        # The User and the Supplier profile are one registration and must
        # succeed or fail together. Unwrapped, a failure while creating the
        # profile (a bad file, a full disk, a dropped connection) left the User
        # row committed and orphaned — and because validate_email rejects an
        # address that already has an account, the applicant was then
        # permanently locked out of registering with their own email, with no
        # way to fix it themselves.
        with transaction.atomic():
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
            # Same transaction: a supplier is never created without the
            # category licenses it was validated with.
            for req, upload, expiry in getattr(self, "_category_uploads", []):
                SupplierCategoryDocument.objects.create(
                    supplier=supplier, key=req["key"], file=upload, expiry_date=expiry)

        # Both side effects are best-effort and deliberately OUTSIDE the
        # transaction: neither should be able to roll back a completed
        # registration, and on_commit semantics don't apply to work that is
        # allowed to fail silently.
        send_verification_email(user)

        uploaded = getattr(self, "_category_uploads", [])
        if uploaded:
            from accounts.audit import log_action  # noqa: PLC0415 — local like notify_admins below
            log_action(
                self.context.get("request"), "supplier.category_documents_uploaded",
                entity_type="Supplier", entity_id=supplier.id, user=None,
                description=f"{supplier.company} uploaded at registration: "
                            + ", ".join(req["label"] for req, _, _ in uploaded) + ".",
            )

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
    which dashboard to open — no role picker needed.

    Every failure returns the SAME message. It used to distinguish "no account
    found with that username or email" from "incorrect password", which turned
    this endpoint into an account-enumeration oracle: anyone could test an email
    address and learn from the wording alone whether it was registered. That
    directly undermined PasswordResetRequestView, which deliberately returns one
    generic response for exactly this reason. The old version also appended "your
    password was changed N ago" to a failed attempt — telling an UNAUTHENTICATED
    caller when the account was last touched.

    The trade-off is a slightly less helpful message for a user who genuinely
    mistyped their email; the login screen points at Forgot Password and Register
    to cover that.
    """

    # One message for every failure mode, so nothing can be inferred from wording.
    INVALID_CREDENTIALS = (
        "The username/email or password is incorrect. Please check your details and try again."
    )

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
        if user_obj is None or not user_obj.is_active:
            # Deliberately indistinguishable from a wrong password — including
            # for a disabled account, whose existence is equally private.
            raise serializers.ValidationError({"detail": self.INVALID_CREDENTIALS})

        # Authenticate with the resolved username (SimpleJWT uses USERNAME_FIELD).
        attrs[self.username_field] = user_obj.get_username()
        try:
            data = super().validate(attrs)
        except AuthenticationFailed:
            raise serializers.ValidationError({"detail": self.INVALID_CREDENTIALS})

        data["user"] = UserSerializer(self.user).data
        return data
