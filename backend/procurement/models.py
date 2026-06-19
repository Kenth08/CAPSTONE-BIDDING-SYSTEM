import os
import uuid

from django.conf import settings
from django.db import models
from django.utils.text import get_valid_filename

from .validators import validate_bid_upload, validate_image_upload, validate_upload


# Supplier documents in display order: (model field, human label, required at registration).
# Reused by the detail serializer and the admin review actions so the set of
# documents stays in one place. Keys mirror the uploaders in SupplierRegister.jsx.
SUPPLIER_DOCUMENT_FIELDS = [
    ("sec_dti_certificate", "SEC / DTI Certificate", True),
    ("mayors_permit", "Mayor's / Business Permit", True),
    ("philgeps_certificate", "PhilGEPS Certificate", True),
    ("valid_id", "Valid Government ID", True),
    ("tax_clearance_certificate", "Tax Clearance Certificate", True),
    ("audited_financial_statements", "Audited Financial Statements", True),
    ("bank_reference_letter", "Bank Reference Letter", True),
    ("authorization_letter", "Authorization Letter / SPA", True),
    ("performance_certificates", "Performance Certificates / ISO", False),
    ("past_contracts", "Past Contracts / POs", False),
]
SUPPLIER_DOCUMENT_KEYS = [key for key, _, _ in SUPPLIER_DOCUMENT_FIELDS]


# Single source of truth for procurement/business categories — used BOTH for
# supplier registration (a supplier may pick several) and for the procurement
# category on a project (exactly one). Supplier eligibility = the project's
# category appears in the supplier's selected categories.
PROCUREMENT_CATEGORIES = [
    "IT Equipment", "Office Supplies", "Furniture", "Construction",
    "Electrical Supplies", "Laboratory Equipment", "Printing Services",
    "Janitorial Supplies", "Food & Catering", "Transportation Services",
    "Medical Supplies", "Sports Equipment", "Books & Educational Materials",
]

# Documents the Admin must upload before a procurement can be submitted for
# approval: (model field, human label, required).
PROCUREMENT_DOCUMENT_FIELDS = [
    ("purchase_request", "Purchase Request (PR)", True),
    ("technical_specifications", "Technical Specifications", True),
    ("terms_of_reference", "Terms of Reference (TOR)", True),
    ("approved_budget_document", "Approved Budget Document", True),
    ("bid_evaluation_criteria", "Bid Evaluation Criteria", True),
]
PROCUREMENT_DOCUMENT_KEYS = [key for key, _, _ in PROCUREMENT_DOCUMENT_FIELDS]


def procurement_doc_path(instance, filename):
    """Store each procurement document under a per-project folder with a short,
    sanitized, unique name."""
    base, ext = os.path.splitext(filename)
    base = get_valid_filename(base)[:40] or "doc"
    ext = ext.lower()[:10]
    unique = uuid.uuid4().hex[:8]
    return f"procurement_docs/{instance.pk or 'new'}/{base}_{unique}{ext}"


def procurement_image_path(instance, filename):
    """Store an optional procurement reference image under procurement_images/
    with a short, sanitized, unique name."""
    base, ext = os.path.splitext(filename)
    base = get_valid_filename(base)[:40] or "image"
    ext = ext.lower()[:10]
    unique = uuid.uuid4().hex[:8]
    return f"procurement_images/{base}_{unique}{ext}"


def supplier_doc_path(instance, filename):
    """Store each supplier's document under a per-supplier folder with a short,
    sanitized, unique name (long original filenames would overflow the column
    and unsafe characters are stripped)."""
    base, ext = os.path.splitext(filename)
    base = get_valid_filename(base)[:40] or "doc"
    ext = ext.lower()[:10]
    unique = uuid.uuid4().hex[:8]
    return f"supplier_docs/{instance.pk or 'new'}/{base}_{unique}{ext}"


class Supplier(models.Model):
    """A supplier company profile, linked to a user account."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        APPROVED = "approved", "Approved"

    class Qualification(models.TextChoices):
        PENDING = "waiting_admin_approval", "Waiting Admin Approval"
        NEEDS_REVISION = "needs_revision", "Needs Revision"
        VERIFIED = "verified", "Verified"
        REJECTED = "rejected", "Rejected"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="supplier_profile",
        null=True,
        blank=True,
    )
    company = models.CharField(max_length=200)
    contact = models.CharField(max_length=150)
    business_type = models.CharField(max_length=255, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    qualification_status = models.CharField(
        max_length=30, choices=Qualification.choices, default=Qualification.PENDING
    )
    email_verified = models.BooleanField(default=False)
    registered = models.DateField(auto_now_add=True)

    # ── Company details (registration Step 1) ─────────────────────────────
    company_address = models.CharField(max_length=500, blank=True)
    phone_number = models.CharField(max_length=30, blank=True)
    tin = models.CharField("TIN", max_length=30, blank=True)
    representative_name = models.CharField(max_length=150, blank=True)
    business_types = models.JSONField(default=list, blank=True)  # selected categories

    # ── Legal documents (Step 2 — required at registration) ───────────────
    sec_dti_certificate = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    mayors_permit = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    philgeps_certificate = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    valid_id = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    mayors_permit_expiry = models.DateField(null=True, blank=True)

    # ── Financial documents (Step 2 — required at registration) ───────────
    tax_clearance_certificate = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    audited_financial_statements = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    bank_reference_letter = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    tax_clearance_expiry = models.DateField(null=True, blank=True)
    financial_statement_year = models.PositiveIntegerField(null=True, blank=True)

    # ── Representative authorization (Step 2 — required) ───────────────────
    authorization_letter = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )

    # ── Qualifications & track record (Step 2 — optional) ─────────────────
    performance_certificates = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    past_contracts = models.FileField(
        upload_to=supplier_doc_path, validators=[validate_upload], max_length=255, blank=True, null=True
    )
    track_record_description = models.TextField(blank=True)

    # ── Declaration (Step 3) ──────────────────────────────────────────────
    declaration_accepted = models.BooleanField(default=False)

    # ── Admin review (verification gate) ──────────────────────────────────
    admin_notes = models.TextField(blank=True)  # overall decision / revision message
    # Per-document review state, keyed by document field name:
    #   {"valid_id": {"status": "needs_revision", "note": "blurry scan"}}
    document_reviews = models.JSONField(default=dict, blank=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return self.company


class Project(models.Model):
    """A procurement project. Flows: draft -> pending_head -> approved ->
    published -> awarded / closed; or pending_head -> rejected (by the Head)."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PENDING_HEAD = "pending_head", "Pending Head Approval"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"
        PUBLISHED = "published", "Published"
        AWARDED = "awarded", "Awarded"
        CLOSED = "closed", "Closed"

    code = models.CharField(max_length=20, unique=True)  # e.g. P-2026-001
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    budget = models.DecimalField(max_digits=14, decimal_places=2, default=0)  # Approved Budget (ABC)
    deadline = models.DateField(null=True, blank=True)  # bid submission deadline
    type = models.CharField(max_length=120, blank=True)
    # Procurement category (one of PROCUREMENT_CATEGORIES) — drives supplier eligibility.
    category = models.CharField(max_length=120, blank=True)
    delivery_location = models.CharField(max_length=255, blank=True)
    expected_delivery_date = models.DateField(null=True, blank=True)
    eligible_types = models.CharField(max_length=120, default="Open to All")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    # Required procurement documents (blank at model level so drafts can exist;
    # enforced when submitting for approval — see the serializer).
    purchase_request = models.FileField(
        upload_to=procurement_doc_path, blank=True, null=True, validators=[validate_upload])
    technical_specifications = models.FileField(
        upload_to=procurement_doc_path, blank=True, null=True, validators=[validate_upload])
    terms_of_reference = models.FileField(
        upload_to=procurement_doc_path, blank=True, null=True, validators=[validate_upload])
    approved_budget_document = models.FileField(
        upload_to=procurement_doc_path, blank=True, null=True, validators=[validate_upload])
    bid_evaluation_criteria = models.FileField(
        upload_to=procurement_doc_path, blank=True, null=True, validators=[validate_upload])
    # Optional visual reference of the exact product/model/colour required, so
    # suppliers bid on the right thing. Not every procurement needs one. Set on
    # the request and carried through the whole project lifecycle (approval keeps
    # the same row, so no copy step is needed).
    reference_image = models.FileField(
        upload_to=procurement_image_path, blank=True, null=True, validators=[validate_image_upload])
    # Set when the Head approves/rejects; reject_reason explains a rejection.
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reject_reason = models.TextField(blank=True)
    # Set when the Admin publishes the project for bidding / when a winner is
    # selected — together with created_at/reviewed_at these make up the full
    # procurement timeline shown to the Admin.
    published_at = models.DateTimeField(null=True, blank=True)
    awarded_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="projects",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def bid_count(self):
        return self.bids.count()

    def __str__(self):
        return f"{self.code} - {self.name}"


class Bid(models.Model):
    """A supplier's bid on a project."""

    class Status(models.TextChoices):
        UNDER_REVIEW = "under_review", "Under Review"
        QUALIFIED = "qualified", "Qualified"
        DISQUALIFIED = "disqualified", "Disqualified"
        WINNER = "winner", "Winner Selected"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="bids")
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="bids")
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    notes = models.TextField(blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.UNDER_REVIEW)
    submitted_at = models.DateTimeField(auto_now_add=True)
    # Set when the Admin qualifies/disqualifies this bid — part of the
    # procurement timeline (evaluation step).
    reviewed_at = models.DateTimeField(null=True, blank=True)

    # ── Required bid information (enforced in the view, nullable so older bids
    #    submitted before these fields existed are never broken) ──────────────
    delivery_timeline = models.CharField(max_length=100, blank=True)
    additional_comments = models.TextField(blank=True)

    # ── Product specification match (offered product details) ─────────────────
    brand_name = models.CharField(max_length=255, blank=True, null=True)
    model_number = models.CharField(max_length=255, blank=True, null=True)
    warranty_period = models.CharField(max_length=100, blank=True, null=True)
    supplier_product_image = models.FileField(
        upload_to="bid_documents/product_images/", validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)
    supplier_datasheet = models.FileField(
        upload_to="bid_documents/supplier_datasheets/", validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)
    supplier_compliance_doc = models.FileField(
        upload_to="bid_documents/compliance_docs/", validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)

    # ── Supporting documents ──────────────────────────────────────────────────
    # Quotation is required (enforced in the view); kept nullable at the model
    # level so the migration doesn't fail on existing rows.
    quotation_document = models.FileField(
        upload_to="bid_documents/quotations/", validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)
    technical_document = models.FileField(
        upload_to="bid_documents/technical/", validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)

    # ── Declarations & compliance (RA 9184). Enforced True in the view ────────
    terms_accepted = models.BooleanField(default=False)
    interest_declared = models.BooleanField(default=False)
    scm_declared = models.BooleanField(default=False)
    accuracy_confirmed = models.BooleanField(default=False)
    # Only required when the project has a reference image.
    specification_confirmed = models.BooleanField(default=False)

    class Meta:
        ordering = ["-submitted_at"]
        # One bid per supplier per project (re-submitting updates the amount).
        constraints = [
            models.UniqueConstraint(fields=["project", "supplier"], name="unique_bid_per_supplier_project"),
        ]

    def __str__(self):
        return f"{self.supplier.company} -> {self.project.name} ({self.amount})"


class BidAttachment(models.Model):
    """An extra "Other Attachment" file on a bid — a supplier may upload several,
    each stored as its own row so the count is unbounded."""

    bid = models.ForeignKey(Bid, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(
        upload_to="bid_documents/attachments/", validators=[validate_bid_upload], max_length=255)
    file_name = models.CharField(max_length=255)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "bid_attachments"

    def __str__(self):
        return self.file_name


class Award(models.Model):
    """A finalized award of a project to a supplier."""

    class Status(models.TextChoices):
        WON = "won", "Won"
        CANCELLED = "cancelled", "Cancelled"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="awards")
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="awards")
    bid = models.ForeignKey(Bid, on_delete=models.SET_NULL, null=True, blank=True)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.WON)
    awarded_at = models.DateField(auto_now_add=True)

    class Meta:
        ordering = ["-awarded_at"]

    def __str__(self):
        return f"{self.project.name} -> {self.supplier.company}"


class Document(models.Model):
    """A supplier compliance document with an expiry date."""

    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="documents")
    doc_type = models.CharField(max_length=120)  # e.g. Mayor's Permit, Tax Clearance
    expiry_date = models.DateField()

    class Meta:
        ordering = ["expiry_date"]

    def __str__(self):
        return f"{self.supplier.company} - {self.doc_type}"


class Notification(models.Model):
    """A simple in-app notification (e.g. bid evaluation result / award)."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    message = models.CharField(max_length=300)
    link = models.CharField(max_length=200, blank=True)  # e.g. "/supplier/bids"
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.user} - {self.message[:40]}"
