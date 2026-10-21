"""Which documents a supplier must upload, by business category.

ONE place decides this. Every supplier uploads the 10 BASE documents
(SUPPLIER_DOCUMENT_FIELDS in models.py — unchanged, stored as FileFields on
Supplier). On top of that, a business category can require EXTRA company-level
licenses, listed in CATEGORY_DOCUMENTS below and stored as
SupplierCategoryDocument rows.

To change what a category requires, edit CATEGORY_DOCUMENTS only: registration
(self and Admin-assisted), the requirements API the forms read, the Admin's
approve and approve-categories checks, and the supplier dashboard all follow it.

Rules for an entry:
  * the dict key must be an exact name from PROCUREMENT_CATEGORIES;
  * `key` is stable snake_case and never changes once used — it is stored in
    Supplier.document_reviews and in SupplierCategoryDocument.key;
  * keys must not clash with the base document keys or with each other.
These are checked when this module is imported, so a typo fails at start-up
instead of silently never requiring a document.

Only company-level licenses belong here. Product-level documents (an FDA
product registration, a datasheet) are per product, so they stay on bids.
"""
import re

from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone

from .models import PROCUREMENT_CATEGORIES, SUPPLIER_DOCUMENT_FIELDS, SUPPLIER_DOCUMENT_KEYS, Supplier


def _doc(key, label, *, required, has_expiry, help_text=""):
    return {
        "key": key, "label": label, "required": required,
        "has_expiry": has_expiry, "help_text": help_text,
    }


CATEGORY_DOCUMENTS = {
    "Medical Supplies": [
        _doc("fda_lto", "FDA License to Operate (Medical Device Distributor)",
             required=True, has_expiry=True,
             help_text="Issued by the FDA Center for Device Regulation, Radiation Health and Research."),
    ],
    "Laboratory Equipment": [
        _doc("fda_lto_lab", "FDA License to Operate (if selling diagnostic/medical devices)",
             required=False, has_expiry=True,
             help_text="Only needed if you sell diagnostic or medical devices."),
        _doc("pdea_license", "PDEA License (if selling controlled chemicals)",
             required=False, has_expiry=True,
             help_text="Only needed if you sell controlled precursors or essential chemicals."),
    ],
    "Construction": [
        _doc("pcab_license", "PCAB Contractor's License",
             required=True, has_expiry=True,
             help_text="Philippine Contractors Accreditation Board license, current fiscal year."),
    ],
    "Food & Catering": [
        _doc("sanitary_permit", "Sanitary Permit (LGU Health Office)",
             required=True, has_expiry=True,
             help_text="Issued by your city or municipal health office."),
        _doc("food_handler_health_certs", "Health Certificates of Food Handlers",
             required=True, has_expiry=True,
             help_text="Combine all current certificates into one PDF. Use the earliest expiry date."),
        _doc("fda_lto_food", "FDA License to Operate (if manufacturing/distributing food)",
             required=False, has_expiry=True,
             help_text="Only needed if you manufacture, repack or distribute food products."),
    ],
    "Transportation Services": [
        _doc("ltfrb_cpc", "LTFRB Certificate of Public Convenience / Franchise",
             required=True, has_expiry=True,
             help_text="The franchise that covers the vehicles you will use."),
        _doc("vehicle_or_cr", "LTO Vehicle OR/CR",
             required=True, has_expiry=False,
             help_text="Official Receipt and Certificate of Registration. Combine several vehicles into one PDF."),
    ],
    "Janitorial Supplies": [
        _doc("fda_lto_huhs", "FDA License to Operate (Household/Urban Hazardous Substances)",
             required=False, has_expiry=True,
             help_text="Only needed if you sell household or urban hazardous substances."),
    ],
    "Electrical Supplies": [
        _doc("dti_bps_cert", "DTI-BPS Product Certification (PS/ICC)",
             required=False, has_expiry=True,
             help_text="Philippine Standard mark or Import Commodity Clearance for regulated products."),
    ],
    "IT Equipment": [
        _doc("ntc_dealer_permit", "NTC Dealer Permit (if selling radio/wireless equipment)",
             required=False, has_expiry=True,
             help_text="Only needed if you sell radio or wireless communication equipment."),
    ],
    "Printing Services": [
        _doc("bir_printer_accreditation", "BIR Accreditation as Printer (if printing official receipts)",
             required=False, has_expiry=True,
             help_text="Only needed if you print official receipts or invoices."),
    ],
    # Office Supplies, Furniture, Sports Equipment and Books & Educational
    # Materials need no documents beyond the base set.
}

# Base documents with an expiry date stored on the Supplier itself.
BASE_EXPIRY_FIELDS = {
    "mayors_permit": "mayors_permit_expiry",
    "tax_clearance_certificate": "tax_clearance_expiry",
}

# Multipart field names: catdoc_<key> for the file, catdoc_<key>_expiry for its date.
UPLOAD_PREFIX = "catdoc_"
EXPIRY_SUFFIX = "_expiry"

_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{1,62}[a-z0-9]$")


def validate_registry(registry, categories=PROCUREMENT_CATEGORIES, base_keys=SUPPLIER_DOCUMENT_KEYS):
    """Raise ImproperlyConfigured if `registry` names an unknown category, or a
    document key is malformed or clashes with a base key or another key."""
    problems = []
    seen = {}
    for category, docs in registry.items():
        if category not in categories:
            problems.append(f"'{category}' is not in PROCUREMENT_CATEGORIES")
        for doc in docs:
            key = doc.get("key", "")
            if not _KEY_PATTERN.match(key):
                problems.append(f"'{key}' ({category}) is not a valid snake_case key")
            if key in base_keys:
                problems.append(f"'{key}' ({category}) clashes with a base document key")
            if key in seen:
                problems.append(f"'{key}' is used by both {seen[key]} and {category}")
            seen[key] = category
            if key.endswith(EXPIRY_SUFFIX):
                problems.append(f"'{key}' ({category}) must not end in '{EXPIRY_SUFFIX}'")
            if not doc.get("label"):
                problems.append(f"'{key}' ({category}) has no label")
    if problems:
        raise ImproperlyConfigured("CATEGORY_DOCUMENTS is invalid: " + "; ".join(problems))


validate_registry(CATEGORY_DOCUMENTS)

# key -> (category, document) for every category document.
CATEGORY_DOCUMENT_INDEX = {
    doc["key"]: (category, doc)
    for category, docs in CATEGORY_DOCUMENTS.items()
    for doc in docs
}


def unknown_categories(categories):
    return [c for c in (categories or []) if c not in PROCUREMENT_CATEGORIES]


def _canonical(categories):
    chosen = set(categories or [])
    return [c for c in PROCUREMENT_CATEGORIES if c in chosen]


def base_requirements():
    return [
        {
            "key": key, "label": label, "required": required,
            "has_expiry": key in BASE_EXPIRY_FIELDS, "help_text": "",
            "source": "base", "category": None,
        }
        for key, label, required in SUPPLIER_DOCUMENT_FIELDS
    ]


def category_requirements(categories):
    """The extra documents for `categories`, in category order, each once."""
    out, seen = [], set()
    for category in _canonical(categories):
        for doc in CATEGORY_DOCUMENTS.get(category, []):
            if doc["key"] in seen:
                continue
            seen.add(doc["key"])
            out.append({**doc, "source": "category", "category": category})
    return out


def requirements_for(categories):
    """Base documents + the unique category documents for `categories`.

    Raises ValueError naming any category that isn't in PROCUREMENT_CATEGORIES."""
    unknown = unknown_categories(categories)
    if unknown:
        raise ValueError(f"Unknown business category: {', '.join(unknown)}.")
    return base_requirements() + category_requirements(categories)


def file_exists(field_file):
    """True only if the FieldFile is set AND the object is really in storage.

    Files written to Render's ephemeral disk before S3 storage was configured
    still have a name in the database but nothing behind it; they must count as
    missing. A storage error also counts as missing — when deciding whether a
    supplier may be verified, "couldn't confirm" is not "present"."""
    if not field_file or not getattr(field_file, "name", ""):
        return False
    try:
        return field_file.storage.exists(field_file.name)
    except Exception:  # noqa: BLE001 — see docstring
        return False


def _category_rows(supplier):
    if supplier is None or supplier.pk is None:
        return {}
    return {row.key: row for row in supplier.category_documents.all()}


# Why a document doesn't count. Shown in messages as "(not uploaded)" etc.
NOT_UPLOADED = "not uploaded"
FILE_MISSING = "file missing from storage"
EXPIRED = "expired"

# A license expiring within this many days is flagged ("Expires in 12 days")
# but still counts as valid.
EXPIRING_SOON_DAYS = 30


def document_expiry(supplier, requirement, *, rows=None):
    """The expiry date on record for this document, or None."""
    if requirement["source"] == "base":
        field = BASE_EXPIRY_FIELDS.get(requirement["key"])
        return getattr(supplier, field, None) if field else None
    rows = _category_rows(supplier) if rows is None else rows
    row = rows.get(requirement["key"])
    return row.expiry_date if row else None


def document_status(supplier, requirement, *, rows=None, check_storage=True, today=None):
    """Where one document stands.

    Returns {"reason", "expiry_date", "days_left", "expiring_soon"}. `reason`
    is None when the document is valid, else NOT_UPLOADED, FILE_MISSING (the
    database names a file storage no longer has, e.g. lost to an old Render
    restart) or EXPIRED (its expiry date is before today). A document due to
    expire within EXPIRING_SOON_DAYS is still valid, with expiring_soon=True."""
    today = today or timezone.localdate()
    if requirement["source"] == "base":
        field = getattr(supplier, requirement["key"], None)
    else:
        rows = _category_rows(supplier) if rows is None else rows
        row = rows.get(requirement["key"])
        field = row.file if row else None
    expiry = document_expiry(supplier, requirement, rows=rows)
    days_left = (expiry - today).days if expiry else None

    has_name = bool(field and getattr(field, "name", ""))
    if not has_name:
        reason = NOT_UPLOADED
    elif check_storage and not file_exists(field):
        reason = FILE_MISSING
    elif expiry and expiry < today:
        reason = EXPIRED
    else:
        reason = None
    return {
        "reason": reason,
        "expiry_date": expiry,
        "days_left": days_left,
        "expiring_soon": reason is None and days_left is not None and days_left <= EXPIRING_SOON_DAYS,
    }


def document_present(supplier, requirement, *, rows=None, check_storage=True):
    """True when the document is uploaded, really in storage and not expired."""
    return document_status(supplier, requirement, rows=rows, check_storage=check_storage)["reason"] is None


def missing_documents(supplier, categories, *, include_base=True, check_storage=True):
    """Required documents for `categories` that don't count: not uploaded,
    missing from storage, or expired. Each is the requirement dict plus
    "reason" and "expiry_date".

    `check_storage=False` only checks the database (no storage round trip per
    file) — for list views where one HEAD request per file per row is too slow.
    Anything that decides access (approve, approve-categories) uses the default."""
    requirements = requirements_for(categories)
    if not include_base:
        requirements = [r for r in requirements if r["source"] == "category"]
    rows = _category_rows(supplier)
    today = timezone.localdate()
    out = []
    for r in requirements:
        if not r["required"]:
            continue
        status = document_status(supplier, r, rows=rows, check_storage=check_storage, today=today)
        if status["reason"]:
            out.append({**r, "reason": status["reason"], "expiry_date": status["expiry_date"]})
    return out


def expiring_documents(supplier, categories, *, check_storage=False):
    """Uploaded documents (required or optional) that are expired or expire
    within EXPIRING_SOON_DAYS — for the "incomplete or expired" list badge."""
    rows = _category_rows(supplier)
    today = timezone.localdate()
    out = []
    for r in requirements_for(categories):
        status = document_status(supplier, r, rows=rows, check_storage=check_storage, today=today)
        if status["reason"] == EXPIRED or status["expiring_soon"]:
            out.append({**r, **status})
    return out


def describe(document):
    """'FDA License to Operate (expired 2026-03-01)', '… (not uploaded)', …"""
    reason = document.get("reason")
    if reason == EXPIRED and document.get("expiry_date"):
        return f"{document['label']} (expired {document['expiry_date'].isoformat()})"
    if reason:
        return f"{document['label']} ({reason})"
    return document["label"]


def labels(documents):
    return ", ".join(describe(d) for d in documents)


def validate_future_expiry(value, label):
    """Raise ValueError if an expiry date being entered is already past."""
    if value and value < timezone.localdate():
        raise ValueError(
            f"The {label} expired on {value.isoformat()}. Upload a current, valid copy.")


def document_categories(supplier):
    """The categories whose documents a supplier is asked for: the approved
    set plus, while a change request is pending, the requested categories (so
    the supplier can upload — and the Admin can review — the new licenses
    before approving). Unknown legacy names are skipped."""
    categories = list(supplier.business_types or [])
    if supplier.category_request_status == Supplier.CategoryRequest.PENDING:
        categories += [c for c in (supplier.pending_business_types or []) if c not in categories]
    return [c for c in categories if c in PROCUREMENT_CATEGORIES]


def approved_categories(supplier):
    return [c for c in (supplier.business_types or []) if c in PROCUREMENT_CATEGORIES]


def allowed_review_keys(supplier):
    """Every document key the Admin may flag on this supplier: the 10 base
    documents plus the category documents of document_categories()."""
    return list(SUPPLIER_DOCUMENT_KEYS) + [
        r["key"] for r in category_requirements(document_categories(supplier))]
