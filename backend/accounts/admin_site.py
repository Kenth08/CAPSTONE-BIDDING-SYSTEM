"""Login protection for the Django admin site.

The admin has its own login form, separate from the API's, so without this it
was a side door: no rate limit, no lockout, no second factor, no audit trail.
This form applies the same rules as the API login — five wrong passwords or
codes lock the account for 15 minutes (accounts/lockout.py), every failure is
audit-logged, and when MFA_REQUIRED is on a staff account must also enter its
authenticator (or backup) code (accounts/mfa.py). Installed as
admin.site.login_form in accounts/admin.py, rendered by
templates/admin/secure_login.html.
"""
from django import forms
from django.contrib.admin.forms import AdminAuthenticationForm
from django.contrib.auth import get_user_model

from . import lockout, mfa
from .audit import log_action

User = get_user_model()

NOT_ENROLLED = (
    "Two-factor authentication is required for the admin site. Sign in to the web "
    "app once to set up your authenticator, then come back."
)
BAD_CODE = "The authenticator code is missing or not valid."


class SecureAdminAuthenticationForm(AdminAuthenticationForm):
    otp_code = forms.CharField(
        label="Authenticator code", required=False, max_length=16,
        widget=forms.TextInput(attrs={"autocomplete": "one-time-code", "inputmode": "numeric"}),
        help_text="6-digit code from your authenticator app, or a backup code.",
    )

    def clean(self):
        username = (self.cleaned_data.get("username") or "").strip()
        user = User.objects.filter(username__iexact=username).first() if username else None

        if user is None or not user.is_active:
            if lockout.unknown_identifier_locked(username):
                raise forms.ValidationError(lockout.LOCKED_MESSAGE, code="locked")
            if lockout.record_failure(self.request, None, username, via="admin"):
                raise forms.ValidationError(lockout.LOCKED_MESSAGE, code="locked")
            raise self.get_invalid_login_error()
        if lockout.is_locked(user):
            raise forms.ValidationError(lockout.LOCKED_MESSAGE, code="locked")

        try:
            cleaned = super().clean()
        except forms.ValidationError:
            if lockout.record_failure(self.request, user, username, via="admin"):
                raise forms.ValidationError(lockout.LOCKED_MESSAGE, code="locked")
            raise

        if mfa.mfa_required_for(user, admin_site=True):
            if not user.mfa_enabled:
                raise forms.ValidationError(NOT_ENROLLED, code="mfa_not_enrolled")
            method = mfa.verify_code(user, self.cleaned_data.get("otp_code"))
            if method is None:
                if lockout.record_failure(self.request, user, username, via="admin-mfa"):
                    raise forms.ValidationError(lockout.LOCKED_MESSAGE, code="locked")
                raise forms.ValidationError(BAD_CODE, code="mfa_invalid")
            if method == "backup":
                log_action(self.request, "auth.mfa_backup_code_used", user=user, entity_type="User",
                           entity_id=user.pk, description=f"{user.username} used a backup code (admin site).")

        lockout.record_success(user)
        log_action(self.request, "auth.admin_login", user=user, entity_type="User", entity_id=user.pk,
                   description=f"{user.username} signed in to the Django admin.")
        return cleaned
