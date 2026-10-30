"""Login protection for the Django admin site.

The admin has its own login form, separate from the API's, so without this it
was a side door: no rate limit, no lockout, no audit trail. This form applies
the same rules as the API login (accounts/lockout.py) — five wrong passwords
lock the account for 15 minutes, every failure is audit-logged — and is
installed as admin.site.login_form in accounts/admin.py.
"""
from django import forms
from django.contrib.admin.forms import AdminAuthenticationForm
from django.contrib.auth import get_user_model

from . import lockout

User = get_user_model()


class SecureAdminAuthenticationForm(AdminAuthenticationForm):
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
        lockout.record_success(user)
        return cleaned
