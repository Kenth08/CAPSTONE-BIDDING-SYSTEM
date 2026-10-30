"""Two-factor authentication (TOTP) for Admin and Head accounts.

WHO NEEDS IT
------------
When settings.MFA_REQUIRED is on (the production default), every Admin and
Head account — and every staff account signing in to the Django admin — must
enter a 6-digit code from an authenticator app after their password. Suppliers
are not affected.

HOW SIGN-IN WORKS
-----------------
1. POST /api/auth/login/ with the password. For an MFA account the answer
   contains NO tokens, only `mfa_required` and an `mfa_token`: a signed,
   5-minute ticket proving the password step passed.
2. Not enrolled yet → POST /api/auth/mfa/setup/ {mfa_token} returns a new
   secret and a QR code to scan. Enrolled → skip.
3. POST /api/auth/mfa/verify/ {mfa_token, code} with a TOTP code (or a backup
   code) returns the JWTs. On first enrolment it also returns 10 one-time
   backup codes, shown once.

PROTECTIONS
-----------
* Wrong codes count towards the same 5-attempt account lockout as wrong
  passwords, and a correct password does NOT reset that count for an MFA
  account — otherwise password + 4 guesses, repeated, would allow unlimited
  code guessing.
* A TOTP code is accepted once: the time step it belongs to is remembered, so a
  code shoulder-surfed or phished cannot be replayed within its 30 s window.
* The TOTP secret is stored encrypted when FILE_ENCRYPTION_KEY is set.
* Backup codes are stored only as salted SHA-256 hashes and work once each.
* `manage.py reset_mfa <username>` clears a lost authenticator (the user
  re-enrolls at next sign-in).
"""
import hashlib
import hmac
import secrets
import time

from django.conf import settings
from django.core import signing
from django.utils import timezone

from .audit import log_action

MFA_ROLES = {"admin", "head"}
TOKEN_SALT = "accounts.mfa.login-ticket"
TOKEN_MAX_AGE = 5 * 60
ISSUER = "E-Procurement"
BACKUP_CODE_COUNT = 10
BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"   # no 0/o, 1/l/i


# ── Who must use MFA ─────────────────────────────────────────────────────────
def mfa_required_for(user, *, admin_site=False):
    if not getattr(settings, "MFA_REQUIRED", False) or user is None:
        return False
    if admin_site and user.is_staff:
        return True
    return getattr(user, "role", None) in MFA_ROLES


# ── Login ticket between the password and the code step ─────────────────────
def _password_marker(user):
    # Changing the password invalidates any ticket issued before the change.
    return hashlib.sha256((user.password or "").encode()).hexdigest()[:16]


def issue_login_ticket(user):
    return signing.dumps({"u": user.pk, "p": _password_marker(user)}, salt=TOKEN_SALT)


def user_from_ticket(ticket):
    """The user a still-valid ticket was issued to, or None."""
    from django.contrib.auth import get_user_model

    try:
        data = signing.loads(ticket or "", salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE)
    except signing.BadSignature:
        return None
    user = get_user_model().objects.filter(pk=data.get("u"), is_active=True).first()
    if user is None or not hmac.compare_digest(data.get("p", ""), _password_marker(user)):
        return None
    return user


# ── Secret storage ───────────────────────────────────────────────────────────
def _store_secret(user, secret):
    from procurement.storage_crypto import encrypt_bytes, encryption_enabled

    user.mfa_secret = encrypt_bytes(secret.encode()).decode("ascii") if encryption_enabled() else secret


def _read_secret(user):
    from procurement.storage_crypto import decrypt_bytes

    return decrypt_bytes((user.mfa_secret or "").encode("ascii")).decode("ascii")


def start_enrollment(user):
    """Create (or replace) a pending secret. Returns (secret, otpauth URI, QR as
    an SVG data URI). MFA is not active until the first code is confirmed."""
    import pyotp
    import segno

    secret = pyotp.random_base32()
    _store_secret(user, secret)
    user.mfa_enabled = False
    user.mfa_last_step = None
    user.save(update_fields=["mfa_secret", "mfa_enabled", "mfa_last_step"])
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email or user.username, issuer_name=ISSUER)
    qr = segno.make(uri, error="m").svg_data_uri(scale=5, border=2)
    return secret, uri, qr


# ── Verification ─────────────────────────────────────────────────────────────
def verify_totp(user, code):
    """True for a correct, not-yet-used code in the current ±1 time step."""
    import pyotp

    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(code) != 6 or not user.mfa_secret:
        return False
    totp = pyotp.TOTP(_read_secret(user))
    now_step = int(time.time()) // 30
    for step in (now_step - 1, now_step, now_step + 1):
        if hmac.compare_digest(totp.at(step * 30), code):
            if user.mfa_last_step is not None and step <= user.mfa_last_step:
                return False                  # replay of an already-used code
            user.mfa_last_step = step
            user.save(update_fields=["mfa_last_step"])
            return True
    return False


def _hash_backup(code, salt):
    return hashlib.sha256(f"{salt}:{code}".encode()).hexdigest()


def _normalise_backup(code):
    return "".join(ch for ch in str(code or "").lower() if ch.isalnum())


def generate_backup_codes(user):
    """Replace the user's backup codes with BACKUP_CODE_COUNT new ones and
    return them in plain text (the only time they are ever visible)."""
    from .models import MFABackupCode

    MFABackupCode.objects.filter(user=user).delete()
    codes = []
    for _ in range(BACKUP_CODE_COUNT):
        raw = "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(10))
        salt = secrets.token_hex(8)
        MFABackupCode.objects.create(user=user, salt=salt, code_hash=_hash_backup(raw, salt))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def use_backup_code(user, code):
    """Spend one backup code. True when it matched an unused one."""
    from .models import MFABackupCode

    normalised = _normalise_backup(code)
    if len(normalised) != 10:
        return False
    for row in MFABackupCode.objects.filter(user=user, used_at__isnull=True):
        if hmac.compare_digest(row.code_hash, _hash_backup(normalised, row.salt)):
            updated = MFABackupCode.objects.filter(pk=row.pk, used_at__isnull=True).update(
                used_at=timezone.now())
            return updated == 1
    return False


def verify_code(user, code):
    """A TOTP code or, failing that, a backup code. Returns "totp", "backup"
    or None."""
    if verify_totp(user, code):
        return "totp"
    if use_backup_code(user, code):
        return "backup"
    return None


def reset(user, *, request=None, by=""):
    """Remove MFA from an account (lost phone). The user re-enrolls at the next
    sign-in. Always audit-logged."""
    from .models import MFABackupCode

    user.mfa_enabled = False
    user.mfa_secret = ""
    user.mfa_last_step = None
    user.save(update_fields=["mfa_enabled", "mfa_secret", "mfa_last_step"])
    MFABackupCode.objects.filter(user=user).delete()
    log_action(request, "auth.mfa_reset", entity_type="User", entity_id=user.pk,
               description=f"Two-factor authentication reset for {user.username}"
                           + (f" by {by}." if by else "."))
