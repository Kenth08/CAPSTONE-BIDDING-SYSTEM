from django.conf import settings
from django.db import models


class Supplier(models.Model):
    """A supplier company profile, linked to a user account."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        APPROVED = "approved", "Approved"

    class Qualification(models.TextChoices):
        PENDING = "waiting_admin_approval", "Waiting Admin Approval"
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

    def __str__(self):
        return self.company


class Project(models.Model):
    """A procurement project. Flows: draft -> pending_head -> approved ->
    published -> awarded / closed."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PENDING_HEAD = "pending_head", "Pending Head Approval"
        APPROVED = "approved", "Approved"
        PUBLISHED = "published", "Published"
        AWARDED = "awarded", "Awarded"
        CLOSED = "closed", "Closed"

    code = models.CharField(max_length=20, unique=True)  # e.g. P-2026-001
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    budget = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    deadline = models.DateField(null=True, blank=True)
    type = models.CharField(max_length=120, blank=True)
    eligible_types = models.CharField(max_length=120, default="Open to All")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
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
        SUBMITTED = "submitted", "Submitted"
        UNDER_REVIEW = "under_review", "Under Review"
        WON = "won", "Won"
        LOST = "lost", "Lost"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="bids")
    supplier = models.ForeignKey(Supplier, on_delete=models.CASCADE, related_name="bids")
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.SUBMITTED)
    submitted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-submitted_at"]

    def __str__(self):
        return f"{self.supplier.company} -> {self.project.name} ({self.amount})"


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
