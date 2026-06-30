from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .models import Award, Bid, Project, Supplier

User = get_user_model()


def dummy_pdf(name="doc.pdf"):
    return SimpleUploadedFile(name, b"%PDF-1.4 fake", content_type="application/pdf")


def make_admin():
    return User.objects.create_user(
        username="admin", email="admin@example.com", password="pw", role=User.Role.ADMIN
    )


def make_head():
    return User.objects.create_user(
        username="head", email="head@example.com", password="pw", role=User.Role.HEAD
    )


def make_supplier(*, verified=True, categories=None):
    username = f"supplier{Supplier.objects.count()}"
    user = User.objects.create_user(
        username=username,
        email=f"{username}@example.com",
        password="pw",
        role=User.Role.SUPPLIER,
    )
    supplier = Supplier.objects.create(
        user=user,
        company="Acme Trading Corp.",
        contact="Jane Dela Cruz",
        business_types=categories or ["IT Equipment"],
        qualification_status=(
            Supplier.Qualification.VERIFIED if verified else Supplier.Qualification.PENDING
        ),
    )
    return supplier


def make_project(*, status=Project.Status.PUBLISHED, category="IT Equipment"):
    return Project.objects.create(
        code=f"P-2026-{Project.objects.count() + 1:03d}",
        name="Laptops for the registrar's office",
        category=category,
        status=status,
        budget=50000,
    )


class SupplierReviewTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.supplier = make_supplier(verified=False)

    def test_non_admin_cannot_approve_supplier(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_approve_verifies_supplier_and_emails_them(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/approve/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.supplier.user.email])

    def test_admin_reject_sets_status_and_emails_reason(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/suppliers/{self.supplier.pk}/reject/", {"note": "Missing TIN"}, format="json")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.REJECTED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Missing TIN", mail.outbox[0].body)

    def test_admin_request_revision_requires_at_least_one_flagged_document(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/suppliers/{self.supplier.pk}/request-revision/", {"documents": {}}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


class SupplierSelfEditBusinessTypesTests(APITestCase):
    """A supplier may change their own business_types from Settings — no
    admin re-approval, applies immediately (per user decision, see memory)."""

    def setUp(self):
        cache.clear()
        self.supplier = make_supplier(verified=True, categories=["IT Equipment"])

    def test_supplier_can_update_own_business_types(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch(
            "/api/suppliers/me/", {"business_types": ["IT Equipment", "Furniture"]}, format="json"
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.supplier.refresh_from_db()
        self.assertEqual(self.supplier.business_types, ["IT Equipment", "Furniture"])
        # No re-approval triggered — verification status is untouched.
        self.assertEqual(self.supplier.qualification_status, Supplier.Qualification.VERIFIED)

    def test_business_types_cannot_be_emptied(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"business_types": []}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unknown_business_type_rejected(self):
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.patch("/api/suppliers/me/", {"business_types": ["Not A Real Category"]}, format="json")
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_new_business_type_immediately_unlocks_matching_projects(self):
        # Supplier starts with only "IT Equipment" — a Furniture project isn't visible yet.
        make_project(status=Project.Status.PUBLISHED, category="Furniture")
        self.client.force_authenticate(user=self.supplier.user)
        before = self.client.get("/api/projects/")
        self.assertEqual(len(before.json()), 0)

        self.client.patch("/api/suppliers/me/", {"business_types": ["IT Equipment", "Furniture"]}, format="json")
        after = self.client.get("/api/projects/")
        self.assertEqual(len(after.json()), 1)
        self.assertEqual(after.json()[0]["category"], "Furniture")


class ProjectDocumentRevisionTests(APITestCase):
    """Head can flag a specific procurement document instead of an outright
    reject; the project bounces to Admin's Planning queue, then back to the
    Head's Pending Approval queue once the Admin fixes it."""

    def setUp(self):
        cache.clear()
        self.head = make_head()
        self.admin = make_admin()
        self.project = make_project(status=Project.Status.PENDING_HEAD)
        self.project.purchase_request = dummy_pdf()
        self.project.save()

    def test_head_can_request_revision_on_one_document(self):
        self.client.force_authenticate(user=self.head)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/request-revision/",
            {"documents": {"purchase_request": "wrong file, please reupload"}},
            format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.NEEDS_REVISION)
        self.assertEqual(
            self.project.document_reviews["purchase_request"]["status"], "needs_revision"
        )

    def test_admin_cannot_request_revision(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/request-revision/",
            {"documents": {"purchase_request": "x"}}, format="json",
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_resubmit_returns_project_to_pending_head(self):
        self.client.force_authenticate(user=self.head)
        self.client.post(
            f"/api/projects/{self.project.pk}/request-revision/",
            {"documents": {"purchase_request": "wrong file"}}, format="json",
        )

        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/resubmit-documents/",
            {"purchase_request": dummy_pdf("fixed.pdf")}, format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.status, Project.Status.PENDING_HEAD)
        self.assertEqual(
            self.project.document_reviews["purchase_request"]["status"], "resubmitted"
        )

    def test_cannot_resubmit_when_not_flagged(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/resubmit-documents/",
            {"purchase_request": dummy_pdf("fixed.pdf")}, format="multipart",
        )
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


class BidEvaluationTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = make_admin()
        self.winner_supplier = make_supplier()
        self.other_supplier = make_supplier()
        self.project = make_project()
        self.winning_bid = Bid.objects.create(
            project=self.project, supplier=self.winner_supplier, amount=45000,
        )
        self.other_bid = Bid.objects.create(
            project=self.project, supplier=self.other_supplier, amount=48000,
        )

    def test_non_admin_cannot_qualify_a_bid(self):
        self.client.force_authenticate(user=self.winner_supplier.user)
        res = self.client.post(f"/api/bids/{self.winning_bid.pk}/qualify/")
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_qualify_sets_status_and_emails_supplier(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.winning_bid.pk}/qualify/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.winning_bid.refresh_from_db()
        self.assertEqual(self.winning_bid.status, Bid.Status.QUALIFIED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.winner_supplier.user.email])

    def test_admin_disqualify_sets_status_and_emails_supplier(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.other_bid.pk}/disqualify/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.other_bid.refresh_from_db()
        self.assertEqual(self.other_bid.status, Bid.Status.DISQUALIFIED)
        self.assertEqual(len(mail.outbox), 1)

    def test_select_winner_creates_award_and_emails_every_bidder(self):
        self.client.force_authenticate(user=self.admin)
        res = self.client.post(f"/api/bids/{self.winning_bid.pk}/select-winner/")
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.winning_bid.refresh_from_db()
        self.project.refresh_from_db()
        self.assertEqual(self.winning_bid.status, Bid.Status.WINNER)
        self.assertEqual(self.project.status, Project.Status.AWARDED)
        self.assertTrue(Award.objects.filter(project=self.project, supplier=self.winner_supplier).exists())

        # Winner + the other bidder both get an emailed result.
        self.assertEqual(len(mail.outbox), 2)
        recipients = {m.to[0] for m in mail.outbox}
        self.assertEqual(recipients, {self.winner_supplier.user.email, self.other_supplier.user.email})

    def test_select_winner_computes_expected_delivery_from_award_not_publish(self):
        # Standard procurement practice counts delivery from Notice to Proceed
        # (i.e. from award), not from when bidding closed — so this must be
        # computed at select-winner time, using whatever delivery_period_days
        # was configured, regardless of how long evaluation took.
        self.project.delivery_period_days = 30
        self.project.save(update_fields=["delivery_period_days"])
        self.assertIsNone(self.project.expected_delivery_date)

        self.client.force_authenticate(user=self.admin)
        self.client.post(f"/api/bids/{self.winning_bid.pk}/select-winner/")

        self.project.refresh_from_db()
        expected = timezone.localdate() + timedelta(days=30)
        self.assertEqual(self.project.expected_delivery_date, expected)


class BidSubmissionEligibilityTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.project = make_project()

    def _bid_payload(self):
        return {
            "amount": "10000",
            "delivery_timeline": "2 weeks",
            "notes": "We can deliver within the requested timeline and specifications.",
            "terms_accepted": "true",
            "interest_declared": "true",
            "scm_declared": "true",
            "accuracy_confirmed": "true",
            "quotation_document": dummy_pdf("quotation.pdf"),
        }

    def test_unverified_supplier_cannot_bid(self):
        supplier = make_supplier(verified=False)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_verified_supplier_can_bid_on_published_project(self):
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{self.project.pk}/bid/", self._bid_payload(), format="multipart"
        )
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Bid.objects.filter(project=self.project, supplier=supplier).exists())

    def test_cannot_bid_on_a_project_not_open_for_bidding(self):
        draft_project = make_project(status=Project.Status.DRAFT)
        supplier = make_supplier(verified=True)
        self.client.force_authenticate(user=supplier.user)
        res = self.client.post(
            f"/api/projects/{draft_project.pk}/bid/", self._bid_payload(), format="multipart"
        )
        # A non-published project is excluded from get_queryset entirely for a
        # supplier, so get_object() 404s before the status check even runs.
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
