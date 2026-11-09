
from django.conf import settings
from django.db import models

from .uploads import SecureUploadsMixin, random_storage_name
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


# Bid documents in display order: (model field, human label, required at submission).
# Same per-document review pattern as SUPPLIER_DOCUMENT_FIELDS above — lets the
# Admin flag a single document on a bid without disqualifying the whole bid.
BID_DOCUMENT_FIELDS = [
    ("quotation_document", "Quotation Document", True),
    ("technical_document", "Technical Proposal", False),
    ("supplier_product_image", "Product Image", False),
    ("supplier_datasheet", "Product Datasheet", False),
    ("supplier_compliance_doc", "Compliance Document", False),
]
BID_DOCUMENT_KEYS = [key for key, _, _ in BID_DOCUMENT_FIELDS]

# The set of BidProductImage rows is reviewed as ONE item in Bid.document_reviews
# under this key. It is deliberately NOT in BID_DOCUMENT_FIELDS: those are single
# FileFields on Bid (the resubmit/request-revision loops setattr/getattr them),
# whereas product images live in their own table and are handled explicitly.
PRODUCT_IMAGES_REVIEW_KEY = "product_images"
PRODUCT_IMAGES_REVIEW_LABEL = "Product Images"


# Post-award documents in the order real procurement issues them: the BAC
# resolves to award, the winner is formally notified (NOA), then authorised to
# start work (NTP). Each is (model field, human label, blockchain stage).
#
# These are the documents a dispute actually turns on — an NTP fixes when the
# delivery clock started, so backdating one is a classic way to hide a late
# delivery. Every upload is hashed and anchored, which makes that impossible to
# do quietly.
# (model field, human label, blockchain stage, "issued at" field)
AWARD_DOCUMENT_FIELDS = [
    ("award_resolution", "BAC Resolution", "RESOLUTION_ISSUED", "resolution_issued_at"),
    ("notice_of_award", "Notice of Award (NOA)", "NOA_ISSUED", "noa_issued_at"),
    ("notice_to_proceed", "Notice to Proceed (NTP)", "NTP_ISSUED", "ntp_issued_at"),
]
AWARD_DOCUMENT_KEYS = [key for key, _, _, _ in AWARD_DOCUMENT_FIELDS]
AWARD_DOCUMENT_STAGES = {key: stage for key, _, stage, _ in AWARD_DOCUMENT_FIELDS}
AWARD_DOCUMENT_ISSUED_FIELDS = {key: issued for key, _, _, issued in AWARD_DOCUMENT_FIELDS}


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

CATEGORY_NAME_MAX_LENGTH = 120


class ProcurementCategory(models.Model):
    """A category the Admin added on top of the built-in PROCUREMENT_CATEGORIES.

    Categories drive supplier eligibility (a project is visible only to suppliers
    who chose its category), so a project's category can't be arbitrary text:
    nobody would match it. Instead the Admin adds a named category here, and from
    then on it can be picked for projects AND by suppliers at registration or in
    Settings. Added categories have no category-specific documents (only the base
    documents); those stay defined in code (document_requirements.CATEGORY_DOCUMENTS)."""

    name = models.CharField(max_length=CATEGORY_NAME_MAX_LENGTH, unique=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


def all_categories():
    """Every valid category name: the built-in list first (in its fixed order),
    then the Admin-added ones alphabetically."""
    builtin = set(PROCUREMENT_CATEGORIES)
    added = [n for n in ProcurementCategory.objects.values_list("name", flat=True) if n not in builtin]
    return list(PROCUREMENT_CATEGORIES) + added


def known_categories(names):
    """`names` kept in order, minus any that aren't a category. Built-in names
    are checked without touching the database, so the common case (every name
    built in) costs no query; this runs once per supplier in list views."""
    names = list(names or [])
    builtin = set(PROCUREMENT_CATEGORIES)
    rest = {n for n in names if n not in builtin}
    if rest:
        rest = set(ProcurementCategory.objects.filter(name__in=rest).values_list("name", flat=True))
    return [n for n in names if n in builtin or n in rest]


def canonical_categories(names):
    """`names` de-duplicated and unknown ones dropped, in all_categories() order:
    built-ins in their fixed order, then added ones alphabetically."""
    chosen = set(known_categories(names))
    builtin = [c for c in PROCUREMENT_CATEGORIES if c in chosen]
    return builtin + sorted(chosen - set(PROCUREMENT_CATEGORIES))


def find_category(name):
    """The existing category name matching `name` ignoring case and spacing,
    or None. Stops 'it equipment' becoming a second 'IT Equipment'."""
    key = " ".join(str(name or "").split()).casefold()
    return next((c for c in all_categories() if c.casefold() == key), None)


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
    """Procurement documents (PR, ToR, specs, ABC, criteria). Random name only; see procurement/uploads.py."""
    return random_storage_name("procurement_docs", filename)


def procurement_image_path(instance, filename):
    """Optional procurement reference image. Random name only; see procurement/uploads.py."""
    return random_storage_name("procurement_images", filename)


def award_doc_path(instance, filename):
    """Post-award documents (BAC Resolution, NOA, NTP). Random name only; see procurement/uploads.py."""
    return random_storage_name("award_docs", filename)


def bid_product_image_path(instance, filename):
    """Bid product photos. Random name only; see procurement/uploads.py."""
    return random_storage_name("bid_documents/product_images", filename)


def bid_document_path(instance, filename):
    """Bid documents and attachments (quotation, technical proposal, datasheet,
    compliance document, other attachments). Random name only."""
    return random_storage_name("bid_documents", filename)


def supplier_doc_path(instance, filename):
    """Supplier registration documents. Random name only; see procurement/uploads.py."""
    return random_storage_name("supplier_docs", filename)


class Supplier(SecureUploadsMixin, models.Model):
    """A supplier company profile, linked to a user account."""

    # Registration documents (IDs, tax and financial records) are encrypted at
    # rest with FILE_ENCRYPTION_KEY — see procurement/storage_crypto.py.
    ENCRYPTED_FILE_FIELDS = frozenset(SUPPLIER_DOCUMENT_KEYS)

    # The uploader's original file names, {field: name}. Stored names are
    # random (procurement/uploads.py), so this is what downloads are named.
    # db_default lets the previous release keep inserting rows mid-deploy.
    original_filenames = models.JSONField(default=dict, db_default={}, blank=True)

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
    # The APPROVED categories — the only ones that grant eligibility (project
    # visibility, bidding, document access, publish notifications all read this).
    business_types = models.JSONField(default=list, blank=True)

    # ── Category change request ───────────────────────────────────────────
    # A VERIFIED supplier can't change business_types directly: that used to
    # take effect instantly, so a supplier verified for one category could
    # start bidding in any other. A change is stored here as a request and only
    # copied into business_types by an Admin (approve-categories). Pending and
    # rejected requests never grant eligibility — nothing that decides access
    # reads these fields.
    #
    # All nullable or with a DB default: on deploy, migrate runs while the
    # previous release is still serving, and its INSERTs don't know these
    # columns exist (same reason as Project.require_product_images).
    class CategoryRequest(models.TextChoices):
        NONE = "", "No request"
        PENDING = "pending", "Pending Admin approval"
        REJECTED = "rejected", "Rejected"

    pending_business_types = models.JSONField(null=True, blank=True)  # requested full set
    category_request_status = models.CharField(
        max_length=20, choices=CategoryRequest.choices, blank=True, default="", db_default="")
    category_request_note = models.CharField(max_length=500, blank=True, default="", db_default="")
    category_requested_at = models.DateTimeField(null=True, blank=True)
    category_reviewed_at = models.DateTimeField(null=True, blank=True)

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


def supplier_category_doc_path(instance, filename):
    """Supplier category licenses. Random name only; see procurement/uploads.py."""
    return random_storage_name("supplier_docs", filename)


class SupplierCategoryDocument(SecureUploadsMixin, models.Model):
    """An extra license a business category requires (e.g. an FDA License to
    Operate for Medical Supplies), on top of the 10 base documents that stay as
    FileFields on Supplier.

    Which keys exist, and which are required, is decided by CATEGORY_DOCUMENTS
    in document_requirements.py. One row per (supplier, key): a re-upload
    replaces the file on the same row. Review state is kept in
    Supplier.document_reviews under the same key, so flag / approve / resubmit
    work exactly like the base documents.

    A separate table rather than new Supplier columns: on deploy, migrate runs
    while the previous release is still serving, and a new table is invisible
    to it — nothing it inserts can fail."""

    # Category licenses are encrypted at rest — see procurement/storage_crypto.py.
    ENCRYPTED_FILE_FIELDS = frozenset({"file"})

    # The uploader's original file names, {field: name}. Stored names are
    # random (procurement/uploads.py), so this is what downloads are named.
    # db_default lets the previous release keep inserting rows mid-deploy.
    original_filenames = models.JSONField(default=dict, db_default={}, blank=True)

    supplier = models.ForeignKey(
        Supplier, on_delete=models.CASCADE, related_name="category_documents")
    key = models.CharField(max_length=64)
    file = models.FileField(
        upload_to=supplier_category_doc_path, validators=[validate_upload], max_length=255)
    expiry_date = models.DateField(null=True, blank=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["supplier_id", "key"]
        constraints = [
            models.UniqueConstraint(
                fields=["supplier", "key"], name="unique_supplier_category_document"),
        ]

    def __str__(self):
        return f"{self.supplier_id} · {self.key}"


class Project(SecureUploadsMixin, models.Model):
    """A procurement project. Flows: draft -> pending_head -> approved ->
    published -> awarded / closed; or pending_head -> rejected (by the Head);
    or pending_head -> needs_revision -> pending_head (Head flags a specific
    document, Admin fixes it, it returns to the Head's queue)."""

    # The uploader's original file names, {field: name}. Stored names are
    # random (procurement/uploads.py), so this is what downloads are named.
    # db_default lets the previous release keep inserting rows mid-deploy.
    original_filenames = models.JSONField(default=dict, db_default={}, blank=True)

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PENDING_HEAD = "pending_head", "Pending Head Approval"
        NEEDS_REVISION = "needs_revision", "Needs Revision"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"
        PUBLISHED = "published", "Published"
        AWARDED = "awarded", "Awarded"
        CLOSED = "closed", "Closed"

    code = models.CharField(max_length=20, unique=True)  # e.g. PC-7K4M-Q9XT-3HWD (older: PRC-2026-7K4M-Q9XT, P-2026-001)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    budget = models.DecimalField(max_digits=14, decimal_places=2, default=0)  # Approved Budget (ABC)
    # Bid submission deadline. NOT set by the Admin directly — it's computed
    # automatically when the procurement is published (today + bidding_period_days),
    # so it can never go stale while the project waits in approval. Stays null
    # until publish.
    deadline = models.DateField(null=True, blank=True)
    # How many days suppliers get to bid, chosen at creation time. The actual
    # deadline date is calculated from this the moment Publish is clicked —
    # see ProjectViewSet.publish.
    bidding_period_days = models.PositiveSmallIntegerField(null=True, blank=True)
    type = models.CharField(max_length=120, blank=True)
    # Procurement category (one of all_categories()) — drives supplier eligibility.
    category = models.CharField(max_length=120, blank=True)
    delivery_location = models.CharField(max_length=255, blank=True)
    # Expected delivery date. NOT set by the Admin directly — like `deadline`,
    # it's computed automatically (at AWARD time: awarded_at + delivery_period_days)
    # so a delivery promise never goes stale while the project sits in approval
    # or bid evaluation. Standard procurement practice counts delivery period
    # from Notice to Proceed (i.e. after a winner is chosen), not from bid close.
    expected_delivery_date = models.DateField(null=True, blank=True)
    delivery_period_days = models.PositiveSmallIntegerField(null=True, blank=True)
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
    # When True, every bid must carry at least one BidProductImage — for
    # procurements where the exact product/brand/style matters. Off by default,
    # so every project created before this existed behaves exactly as it did.
    # Deliberately NOT part of the anchored project payload (see blockchain.py).
    #
    # db_default (not just default) keeps the default in the DATABASE too: on
    # deploy, migrate runs while the previous release is still serving, and its
    # INSERTs don't know these columns exist — without a DB-level default they
    # would fail NOT NULL for the length of that window.
    require_product_images = models.BooleanField(default=False, db_default=False)
    # Optional guidance shown to suppliers above the image upload, e.g. "Show
    # the exact brand/model and a photo of the actual product".
    product_image_instructions = models.CharField(
        max_length=300, blank=True, default="", db_default="")
    # Set when the Head approves/rejects/requests revision; reject_reason
    # explains a rejection. document_reviews is per-document review state for
    # the request-revision flow, keyed by document field name — same shape as
    # Supplier.document_reviews and Bid.document_reviews.
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reject_reason = models.TextField(blank=True)
    document_reviews = models.JSONField(default=dict, blank=True)
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


class Bid(SecureUploadsMixin, models.Model):
    """A supplier's bid on a project."""

    # The uploader's original file names, {field: name}. Stored names are
    # random (procurement/uploads.py), so this is what downloads are named.
    # db_default lets the previous release keep inserting rows mid-deploy.
    original_filenames = models.JSONField(default=dict, db_default={}, blank=True)

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
    # Per-document review state, keyed by document field name (same shape as
    # Supplier.document_reviews): {"quotation_document": {"status": "needs_revision", "note": "..."}}.
    # Flagging a document here does NOT disqualify the bid — the supplier stays
    # in the running and just re-uploads the flagged file via resubmit-documents.
    # A bid can't be selected as winner while any document is still flagged.
    document_reviews = models.JSONField(default=dict, blank=True)

    # ── Required bid information (enforced in the view, nullable so older bids
    #    submitted before these fields existed are never broken) ──────────────
    delivery_timeline = models.CharField(max_length=100, blank=True)
    additional_comments = models.TextField(blank=True)

    # ── Product specification match (offered product details) ─────────────────
    brand_name = models.CharField(max_length=255, blank=True, null=True)
    model_number = models.CharField(max_length=255, blank=True, null=True)
    warranty_period = models.CharField(max_length=100, blank=True, null=True)
    supplier_product_image = models.FileField(
        upload_to=bid_document_path, validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)
    supplier_datasheet = models.FileField(
        upload_to=bid_document_path, validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)
    supplier_compliance_doc = models.FileField(
        upload_to=bid_document_path, validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)

    # ── Supporting documents ──────────────────────────────────────────────────
    # Quotation is required (enforced in the view); kept nullable at the model
    # level so the migration doesn't fail on existing rows.
    quotation_document = models.FileField(
        upload_to=bid_document_path, validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)
    technical_document = models.FileField(
        upload_to=bid_document_path, validators=[validate_bid_upload],
        max_length=255, blank=True, null=True)

    # ── Declarations & compliance (RA 9184). Enforced True in the view ────────
    terms_accepted = models.BooleanField(default=False)
    interest_declared = models.BooleanField(default=False)
    scm_declared = models.BooleanField(default=False)
    accuracy_confirmed = models.BooleanField(default=False)
    # Only required when the project has a reference image.
    specification_confirmed = models.BooleanField(default=False)

    # ── Evaluation commitment (set once, at award time) ───────────────────────
    # Inputs to this bid's leaf in the EVALUATION_COMPLETED anchor (see
    # blockchain.bid_leaf). The salt is random and secret: without it, a leaf
    # (and so the public anchor hash) could be brute-forced back to an amount.
    # Never serialized except in the bid owner's own inclusion receipt.
    # db_default so the previous release can keep inserting rows mid-deploy.
    commitment_salt = models.CharField(max_length=64, blank=True, default="", db_default="")
    committed_document_hash = models.CharField(max_length=66, blank=True, default="", db_default="")

    class Meta:
        ordering = ["-submitted_at"]
        # One bid per supplier per project (re-submitting updates the amount).
        constraints = [
            models.UniqueConstraint(fields=["project", "supplier"], name="unique_bid_per_supplier_project"),
        ]

    def __str__(self):
        return f"{self.supplier.company} -> {self.project.name} ({self.amount})"


class BidAttachment(SecureUploadsMixin, models.Model):
    """An extra "Other Attachment" file on a bid — a supplier may upload several,
    each stored as its own row so the count is unbounded."""

    bid = models.ForeignKey(Bid, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(
        upload_to=bid_document_path, validators=[validate_bid_upload], max_length=255)
    file_name = models.CharField(max_length=255)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "bid_attachments"

    def __str__(self):
        return self.file_name


class BidProductImage(SecureUploadsMixin, models.Model):
    """A photo of the product a supplier is offering, attached to their bid.

    Up to MAX_BID_PRODUCT_IMAGES per bid, each with an optional caption. Kept in
    its own table (rather than more columns on Bid) so the count is flexible and
    old bids need no data migration. Never part of any anchor payload: images
    are evidence for the evaluator, not part of the hashed bid record."""

    bid = models.ForeignKey(Bid, on_delete=models.CASCADE, related_name="product_images")
    image = models.FileField(upload_to=bid_product_image_path, max_length=255)
    caption = models.CharField(max_length=150, blank=True, default="")
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "bid_product_images"
        ordering = ["uploaded_at", "id"]

    def __str__(self):
        return f"Bid {self.bid_id} image {self.pk}"


MAX_BID_PRODUCT_IMAGES = 5


class Award(SecureUploadsMixin, models.Model):
    """A finalized award of a project to a supplier."""

    # The uploader's original file names, {field: name}. Stored names are
    # random (procurement/uploads.py), so this is what downloads are named.
    # db_default lets the previous release keep inserting rows mid-deploy.
    original_filenames = models.JSONField(default=dict, db_default={}, blank=True)

    class Status(models.TextChoices):
        WON = "won", "Won"
        CANCELLED = "cancelled", "Cancelled"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="awards")
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="awards")
    bid = models.ForeignKey(Bid, on_delete=models.SET_NULL, null=True, blank=True)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.WON)
    awarded_at = models.DateField(auto_now_add=True)

    # ── Post-award documents (see AWARD_DOCUMENT_FIELDS) ──────────────────────
    # Uploaded by the Admin as signed PDFs, never generated: a Notice of Award is
    # a signed instrument in the real world, and only a real stored file has a
    # stable hash worth anchoring. Each `*_issued_at` is set when its document is
    # uploaded, so "when was the NTP issued" is answerable from the record and is
    # part of what gets hashed on-chain.
    award_resolution = models.FileField(
        upload_to=award_doc_path, validators=[validate_upload],
        max_length=255, blank=True, null=True)
    notice_of_award = models.FileField(
        upload_to=award_doc_path, validators=[validate_upload],
        max_length=255, blank=True, null=True)
    notice_to_proceed = models.FileField(
        upload_to=award_doc_path, validators=[validate_upload],
        max_length=255, blank=True, null=True)
    resolution_issued_at = models.DateTimeField(null=True, blank=True)
    noa_issued_at = models.DateTimeField(null=True, blank=True)
    ntp_issued_at = models.DateTimeField(null=True, blank=True)

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


class BlockchainAnchor(models.Model):
    """One procurement lifecycle event, hashed and (optionally) anchored on-chain.

    Written by procurement.blockchain.record_anchor() right after a status
    transition succeeds — alongside the AuditLog entry, never instead of it. The
    row is created with an EMPTY tx_hash: the DB is always the source of truth
    for the business record, and the blockchain is an independent, tamper-evident
    witness that gets attached afterwards. A row with no tx_hash simply reads as
    "not yet anchored" and can be retried later, so a rejected MetaMask prompt,
    a wrong network, or an empty gas tank never rolls back an approval.

    Only `data_hash` + entity_type/entity_ref/stage ever leave the server for the
    chain. `payload` and `document_hash` stay here so an auditor can be shown
    exactly what was hashed and recompute it; the public endpoint deliberately
    exposes the hashes only, never the payload (bid amounts and supplier details
    stay private, same as PublicProcurementView).
    """

    class EntityType(models.TextChoices):
        PROJECT = "PROJECT", "Project"
        BID = "BID", "Bid"
        AWARD = "AWARD", "Award"

    # Lifecycle stages, one anchor per status transition. These exact strings go
    # on-chain, so treat them as an append-only vocabulary — never rename one.
    class Stage(models.TextChoices):
        SUBMITTED = "SUBMITTED", "Submitted for approval"
        HEAD_APPROVED = "HEAD_APPROVED", "Approved by Head"
        HEAD_REJECTED = "HEAD_REJECTED", "Rejected by Head"
        REVISION_REQUESTED = "REVISION_REQUESTED", "Revision requested"
        BIDDING_OPEN = "BIDDING_OPEN", "Published for bidding"
        BID_SUBMITTED = "BID_SUBMITTED", "Bid submitted"
        BID_QUALIFIED = "BID_QUALIFIED", "Bid qualified"
        BID_DISQUALIFIED = "BID_DISQUALIFIED", "Bid disqualified"
        AWARDED = "AWARDED", "Contract awarded"
        # Post-award documents — the lifecycle doesn't end at the award; these
        # are the instruments a later dispute turns on (see AWARD_DOCUMENT_FIELDS).
        RESOLUTION_ISSUED = "RESOLUTION_ISSUED", "BAC Resolution issued"
        NOA_ISSUED = "NOA_ISSUED", "Notice of Award issued"
        NTP_ISSUED = "NTP_ISSUED", "Notice to Proceed issued"
        # Written once, at award time: a salted commitment to EVERY bid received
        # and its final outcome (blockchain.evaluation_payload). Proves the set
        # of bids and the evaluation were fixed when the award was made, without
        # putting any losing bidder's amount on the public ledger.
        EVALUATION_COMPLETED = "EVALUATION_COMPLETED", "Evaluation completed (all bids committed)"

    entity_type = models.CharField(max_length=10, choices=EntityType.choices)
    # The procurement code (e.g. "PC-7K4M-Q9XT-3HWD") for EVERY anchor — project, bid
    # and award alike — because that's how the contract indexes anchors, so one
    # on-chain lookup returns a procurement's whole trail.
    entity_ref = models.CharField(max_length=64)
    # Local PK of the anchored row (project/bid/award id). Off-chain only:
    # needed to tell two suppliers' BID_SUBMITTED anchors apart when attaching a
    # tx hash. Never part of the hashed payload's identity on its own.
    entity_id = models.CharField(max_length=32, blank=True)
    stage = models.CharField(max_length=32, choices=Stage.choices)
    # "0x" + 64 hex chars = 66. SHA-256 of the canonical payload below.
    data_hash = models.CharField(max_length=66)
    # SHA-256 of the key document for this stage ("" when the stage has none).
    # Published to the public verifier so an uploaded file can be checked
    # against it; it is also an input to data_hash, so the chain binds it.
    document_hash = models.CharField(max_length=66, blank=True)
    # Exactly what was hashed, kept for auditability (admin-only reads).
    payload = models.JSONField(default=dict, blank=True)
    # Filled in once the transaction confirms; blank = not yet anchored.
    tx_hash = models.CharField(max_length=66, blank=True)
    block_number = models.PositiveBigIntegerField(null=True, blank=True)
    # Wallet/signer that submitted the transaction, when known.
    actor_address = models.CharField(max_length=42, blank=True)
    anchored_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    # What the SERVER found when it read this transaction back from Sepolia
    # (blockchain.confirm_anchor). A tx_hash on its own is only a claim the
    # browser posted; it counts as on-chain once this says CONFIRMED: a
    # successful transaction to the ledger contract that emitted an
    # AnchorRecorded event with exactly this entity/code/stage/hash.
    # db_default so the previous release can keep inserting rows mid-deploy.
    class ChainStatus(models.TextChoices):
        UNCHECKED = "unchecked", "Not checked yet"
        CONFIRMED = "confirmed", "Confirmed on-chain"
        MISMATCH = "mismatch", "Transaction does not contain this record"
        REVERTED = "reverted", "Last transaction failed on-chain"
        DROPPED = "dropped", "Last transaction was never mined"

    chain_status = models.CharField(
        max_length=12, choices=ChainStatus.choices,
        default=ChainStatus.UNCHECKED, db_default=ChainStatus.UNCHECKED)
    chain_checked_at = models.DateTimeField(null=True, blank=True)

    # The on-chain identity of the record, copied from the AnchorRecorded event
    # the server decoded (and cross-checked with the contract's getAnchor) when
    # it confirmed the transaction. Never typed in or guessed: empty until then,
    # and left empty for older anchors whose receipt the RPC can no longer serve.
    # `chain_anchor_id` is the contract's own index (getAnchor(id)) — not this
    # row's id and not the tx hash; one transaction can carry several of them.
    chain_anchor_id = models.PositiveBigIntegerField(null=True, blank=True)
    chain_log_index = models.PositiveIntegerField(null=True, blank=True)
    chain_timestamp = models.DateTimeField(null=True, blank=True)   # block time stored by the contract
    chain_id = models.PositiveBigIntegerField(null=True, blank=True)  # network actually read (eth_chainId)
    chain_contract = models.CharField(max_length=42, blank=True, default="", db_default="")
    # Depth when last checked (1 = in the latest block), and whether that block
    # was at or below the chain's `finalized` block. False also when the node
    # could not report finality — "not shown to be final", never assumed final.
    chain_confirmations = models.PositiveBigIntegerField(null=True, blank=True)
    chain_finalized = models.BooleanField(default=False, db_default=False)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(fields=["entity_ref", "created_at"]),
            models.Index(fields=["entity_type", "entity_id"]),
        ]
        constraints = [
            # One on-chain record can back only one anchor row: a batched
            # transaction carries several events, each claimed once, and the
            # same event can never be "reused" to vouch for a second record.
            models.UniqueConstraint(
                fields=["chain_id", "chain_contract", "chain_anchor_id"],
                condition=models.Q(chain_anchor_id__isnull=False),
                name="uniq_onchain_anchor_record",
            ),
        ]

    @property
    def anchored(self):
        """A transaction has been REPORTED for this anchor. Not proof by
        itself — see `verified_on_chain`."""
        return bool(self.tx_hash)

    @property
    def verified_on_chain(self):
        return bool(self.tx_hash) and self.chain_status == self.ChainStatus.CONFIRMED

    def __str__(self):
        state = self.tx_hash[:12] + "…" if self.tx_hash else "not anchored"
        return f"{self.entity_ref} {self.stage} ({state})"


class AwardDocumentVersion(models.Model):
    """One issue of a post-award document (BAC Resolution, NOA, NTP), kept for
    good so every issue stays downloadable and verifiable.

    Re-issuing a document replaces the file on the Award row. Storage keeps the
    old bytes (names are random and nothing deletes them), but nothing else
    remembers where they are — so the version row records the stored NAME at
    issue time. No copy is made: `file` points at exactly the bytes that were
    hashed and anchored.

    Issues made before this table existed have no row. They still appear as
    versions (from their anchors), with their file marked "not preserved":
    the anchor never recorded the file name, and it is not guessed."""

    KEY_CHOICES = [(key, label) for key, label, _, _ in AWARD_DOCUMENT_FIELDS]

    award = models.ForeignKey(Award, on_delete=models.CASCADE, related_name="document_versions")
    key = models.CharField(max_length=32, choices=KEY_CHOICES)
    version = models.PositiveIntegerField()      # issue number, 1 = first issue of this document
    file = models.FileField(upload_to=award_doc_path, max_length=255)
    original_filename = models.CharField(max_length=255, blank=True)
    document_hash = models.CharField(max_length=66, blank=True)   # SHA-256 of the stored bytes
    issued_at = models.DateTimeField()
    generated = models.BooleanField(default=False)               # generated PDF vs uploaded scan
    # The anchor written for this issue, when anchoring produced one. Never
    # filled in afterwards by guesswork.
    anchor = models.OneToOneField(
        BlockchainAnchor, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="document_version")
    issued_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["award_id", "key", "version"]
        constraints = [
            models.UniqueConstraint(fields=["award", "key", "version"], name="uniq_award_document_version"),
        ]

    def __str__(self):
        return f"{self.award_id} {self.key} v{self.version}"


class ProjectDocumentVersionQuerySet(models.QuerySet):
    """Bulk writes would skip the model's own guard, so they are refused too."""

    def _refuse(self, *args, **kwargs):
        raise TypeError("Project document versions are write-once.")

    update = delete = bulk_update = _refuse


class ProjectDocumentVersion(models.Model):
    """One distinct content of a procurement document (procurement/project_documents.py).

    `file` records the stored NAME, as AwardDocumentVersion does: replacing a
    document leaves the old bytes in storage, so no copy is made.

    Write-once: the app can add a row, never edit or delete one, and neither the
    Django admin, a serializer nor a file route exposes them. Deleting a project
    before bidding opens is allowed and its anchors outlive it, so the rows do
    too: `project` goes null and `project_code` still says whose they were."""

    KEY_CHOICES = [(key, label) for key, label, _ in PROCUREMENT_DOCUMENT_FIELDS]

    project = models.ForeignKey(
        Project, on_delete=models.SET_NULL, null=True, related_name="document_versions")
    project_code = models.CharField(max_length=20)
    key = models.CharField(max_length=32, choices=KEY_CHOICES)
    version = models.PositiveIntegerField()      # 1 = first known content of this document
    file = models.FileField(upload_to=procurement_doc_path, max_length=255)
    original_filename = models.CharField(max_length=255, blank=True)
    # SHA-256 of the stored bytes. Blank only if storage couldn't read the file
    # when this row was written.
    sha256 = models.CharField(max_length=66, blank=True)
    # Null when the uploader isn't known: a file that was already on the project
    # when history began. `recorded_at` is when this row was written, which for
    # those files is later than their upload.
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    recorded_at = models.DateTimeField(auto_now_add=True)

    objects = ProjectDocumentVersionQuerySet.as_manager()

    class Meta:
        ordering = ["project_code", "key", "version"]
        constraints = [
            models.UniqueConstraint(fields=["project", "key", "version"], name="uniq_project_document_version"),
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError("Project document versions are write-once.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Project document versions are write-once.")

    def __str__(self):
        return f"{self.project_code} {self.key} v{self.version}"


class CommitmentOpeningQuerySet(models.QuerySet):
    """Bulk writes would skip the model's own guard, so they are refused too."""

    def _refuse(self, *args, **kwargs):
        raise TypeError("Commitment openings are write-once.")

    update = delete = bulk_update = _refuse


class CommitmentOpening(models.Model):
    """The exact object behind one salted commitment, encrypted (procurement/openings.py).

    Write-once, and kept as long as its anchor: an anchor with an opening can't
    be deleted. The only later change is rotating the encryption key, which
    replaces `ciphertext` and `key_fingerprint` (`rewrap`). The salt, the
    commitment and the anchor never change.

    The salt is only ever inside `ciphertext`. `salt_fingerprint`, a SHA-256 of
    the salt, is what lets the database refuse a repeated salt; reversing it
    would mean guessing a 256-bit random value."""

    class Kind(models.TextChoices):
        BID_LEAF = "bid-leaf/3", "Bid leaf"
        AWARD_PRIVATE = "award-private/3", "Award private fields"

    anchor = models.ForeignKey(BlockchainAnchor, on_delete=models.PROTECT, related_name="openings")
    kind = models.CharField(max_length=24, choices=Kind.choices)
    # The bid (bid-leaf/3) or award (award-private/3) this commits to. Several bid
    # leaves share one evaluation anchor, so this is part of a row's identity.
    subject_id = models.PositiveBigIntegerField()
    # Who may read it besides Admin and Head: the bidder, or the awardee.
    supplier = models.ForeignKey(Supplier, on_delete=models.SET_NULL, null=True, related_name="+")
    commitment = models.CharField(max_length=66)     # SHA-256 of the canonical opening
    salt_fingerprint = models.CharField(max_length=64, unique=True)
    ciphertext = models.TextField()
    key_fingerprint = models.CharField(max_length=8)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = CommitmentOpeningQuerySet.as_manager()

    class Meta:
        ordering = ["anchor_id", "kind", "subject_id"]
        constraints = [
            models.UniqueConstraint(fields=["anchor", "kind", "subject_id"], name="uniq_commitment_opening"),
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError("Commitment openings are write-once.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Commitment openings are write-once.")

    @classmethod
    def rewrap(cls, pk, old_ciphertext, new_ciphertext, key_fingerprint):
        """Key rotation only. Conditional, so it can't overwrite a concurrent
        change. Returns whether the row was updated."""
        return models.QuerySet(model=cls).filter(pk=pk, ciphertext=old_ciphertext).update(
            ciphertext=new_ciphertext, key_fingerprint=key_fingerprint) == 1

    def __str__(self):
        return f"anchor {self.anchor_id} {self.kind} {self.subject_id}"


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


class FileDownloadToken(models.Model):
    """A one-time, short-lived grant to download exactly one file.

    Minted by POST /api/files/<kind>/<pk>/<field>/link/ the moment a signed-in
    user clicks "download", and redeemed by the browser navigation that follows
    (which cannot carry the Authorization header). See procurement/files.py.

    Only a SHA-256 of the token is stored, so a database leak does not leak
    working links. Rows are kept after use as part of the download history and
    pruned once they are well past expiry.
    """

    token_hash = models.CharField(max_length=64, unique=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="file_download_tokens")
    kind = models.CharField(max_length=20)
    object_id = models.PositiveBigIntegerField()
    field = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["expires_at"])]

    def __str__(self):
        return f"{self.user_id} {self.kind}/{self.object_id}/{self.field}"
