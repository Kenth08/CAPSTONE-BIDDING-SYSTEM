"""Startup checks for file-storage safety.

Registered as Django system checks, so they run on `manage.py migrate` (which
Render's build.sh runs before every deploy) and `manage.py check --deploy`.
An ERROR stops `migrate`, so a deploy with unsafe storage settings fails at
build time while the previous release keeps serving. Each problem is also
logged at startup by ProcurementConfig.ready().

What counts as unsafe: anything that would let a stored file be read without
going through procurement/files.py — a public ACL on uploads, permanent
unsigned bucket URLs, or a custom domain (django-storages never signs those).
"""
from django.conf import settings
from django.core import checks

PUBLIC_ACLS = {"public-read", "public-read-write", "authenticated-read"}


def storage_problems():
    """[(id, message, hint)] for every unsafe storage setting found."""
    problems = []
    backend = settings.STORAGES.get("default", {}).get("BACKEND", "")
    if "s3" in backend.lower():
        acl = getattr(settings, "AWS_DEFAULT_ACL", None)
        if acl in PUBLIC_ACLS:
            problems.append((
                "procurement.E001", f"AWS_DEFAULT_ACL is {acl!r}: every upload would be public.",
                "Set AWS_DEFAULT_ACL = None and keep the bucket private."))
        if not getattr(settings, "AWS_QUERYSTRING_AUTH", True):
            problems.append((
                "procurement.E002", "AWS_QUERYSTRING_AUTH is off: storage URLs would be permanent "
                                    "and unsigned.",
                "Keep AWS_QUERYSTRING_AUTH = True; files are served through /api/files/."))
        if getattr(settings, "AWS_S3_CUSTOM_DOMAIN", None):
            problems.append((
                "procurement.E003", "AWS_S3_CUSTOM_DOMAIN is set: django-storages returns unsigned "
                                    "public URLs for custom domains.",
                "Unset AWS_S3_CUSTOM_DOMAIN."))
        if getattr(settings, "AWS_QUERYSTRING_EXPIRE", 3600) > 300:
            problems.append((
                "procurement.E004", "AWS_QUERYSTRING_EXPIRE is longer than 5 minutes.",
                "Keep it short (60 seconds)."))
    return problems


def encryption_problems():
    """Warn when supplier documents would be stored unencrypted in production."""
    if settings.DEBUG or getattr(settings, "RUNNING_TESTS", False):
        return []
    if not getattr(settings, "FILE_ENCRYPTION_KEY", ""):
        return [(
            "procurement.W001", "FILE_ENCRYPTION_KEY is not set: new supplier registration "
                                "documents are stored unencrypted.",
            "Generate a Fernet key and set FILE_ENCRYPTION_KEY (see SECURITY.md).")]
    return []


@checks.register(checks.Tags.security)
def check_storage_safety(app_configs, **kwargs):
    out = [checks.Error(msg, hint=hint, id=cid) for cid, msg, hint in storage_problems()]
    out += [checks.Warning(msg, hint=hint, id=cid) for cid, msg, hint in encryption_problems()]
    return out
