"""Personal names: First, Middle (optional) and Last, plus the display name.

Forms now send the three parts. `User.full_name` stays the display name used
everywhere (dashboards, documents, reports, the audit log) and is composed from
the parts. Accounts created before the split keep their `full_name` as typed and
empty parts: a name like "Ma. Cristina Dela Cruz Santos" can't be split safely,
so it is never guessed. Clients that still send a single `full_name` keep working.
"""
from rest_framework import serializers

PART_MAX = 150


def compose_full_name(first, middle, last):
    return " ".join(p for p in (first.strip(), middle.strip(), last.strip()) if p)[:150]


def resolve_name(data, *, required=True):
    """From request data, the (first, middle, last, full_name) to save.

    The three parts win when any is given: then First and Last are required.
    Otherwise a single legacy `full_name` is accepted with empty parts. Returns
    None when nothing name-related was sent and `required` is False (a partial
    profile update that doesn't touch the name)."""
    get = lambda key: str(data.get(key) or "").strip()  # noqa: E731
    first, middle, last = get("first_name"), get("middle_name"), get("last_name")
    if first or middle or last:
        errors = {}
        if not first:
            errors["first_name"] = "Enter the first name."
        if not last:
            errors["last_name"] = "Enter the last name."
        for key, value in (("first_name", first), ("middle_name", middle), ("last_name", last)):
            if len(value) > PART_MAX:
                errors[key] = f"Keep it under {PART_MAX} characters."
        if errors:
            raise serializers.ValidationError(errors)
        return first, middle, last, compose_full_name(first, middle, last)
    legacy = get("full_name")
    if legacy:
        return "", "", "", legacy[:150]
    if required:
        raise serializers.ValidationError({"first_name": "Enter the first name.",
                                           "last_name": "Enter the last name."})
    return None


def apply_name(user, resolved):
    """Copy a resolve_name() result onto a user. Returns the changed field names."""
    first, middle, last, full = resolved
    user.first_name, user.middle_name, user.last_name, user.full_name = first, middle, last, full
    return ["first_name", "middle_name", "last_name", "full_name"]
