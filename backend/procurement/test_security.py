"""Tests for the security-hardening work (see SECURITY.md).

Grouped by protection so a failure points straight at the guarantee that broke:
public bidding IDs, the public blockchain trail, file access, uploads, storage,
authentication and audit logging. Shared fixtures come from tests.py.
"""
import io
import os
import re
import shutil
import tempfile
import zipfile
from datetime import timedelta
from unittest import mock

from cryptography.fernet import Fernet, InvalidToken
from django.core import checks
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase
from PIL import Image

from accounts.models import AuditLog

from .blockchain import anchor_project, verify_anchor
from .checks import check_storage_safety, encryption_problems, storage_problems
from .models import (
    Award,
    Bid,
    BidAttachment,
    BidProductImage,
    BlockchainAnchor,
    FileDownloadToken,
    Project,
    Supplier,
)
from .storage_crypto import MAGIC, decrypt_bytes
from .tests import dummy_pdf, make_admin, make_head, make_project, make_supplier
from .validators import validate_bid_upload, validate_upload
from .views import (
    PROJECT_CODE_ALPHABET,
    PROJECT_CODE_MAX_ATTEMPTS,
    next_project_code,
    normalize_project_code,
)

PC_CODE = re.compile(r"^PC-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}(-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}){2}$")


# ── Public bidding IDs ───────────────────────────────────────────────────────
class BiddingIdFormatTests(TestCase):
    def test_format_is_pc_and_twelve_unambiguous_characters(self):
        for _ in range(200):
            self.assertRegex(next_project_code(), PC_CODE)

    def test_alphabet_has_no_ambiguous_characters(self):
        for ch in "0O1IL":
            self.assertNotIn(ch, PROJECT_CODE_ALPHABET)

    def test_code_contains_no_year_or_running_number(self):
        for _ in range(200):
            code = next_project_code()
            self.assertIsNone(re.search(r"20\d\d", code), code)
            self.assertFalse(code.startswith(("P-", "PRC-")))

    def test_ten_thousand_codes_have_no_duplicates(self):
        codes = {next_project_code() for _ in range(10_000)}
        self.assertEqual(len(codes), 10_000)

    def test_code_fits_the_column_and_the_contract(self):
        code = next_project_code()
        self.assertLessEqual(len(code), Project._meta.get_field("code").max_length)
        self.assertLessEqual(len(code), 64)   # ProcurementLedger entityRef limit

    def test_normalize_accepts_every_format_ever_issued(self):
        self.assertEqual(normalize_project_code("  p-2026-004 "), "P-2026-004")
        self.assertEqual(normalize_project_code("prc-2026-7k4m-q9xt"), "PRC-2026-7K4M-Q9XT")
        self.assertEqual(normalize_project_code("pc-7k4m-q9xt-3hwd\n"), "PC-7K4M-Q9XT-3HWD")
        self.assertEqual(normalize_project_code(None), "")


class BiddingIdCreateTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.client.force_authenticate(user=make_admin())

    def _create(self):
        from .tests import dummy_pdf
        return self.client.post("/api/projects/", {
            "name": "Test procurement", "type": "Goods", "category": "IT Equipment",
            "delivery_location": "HQ", "budget": "1000",
            "bidding_period_days": 10, "delivery_period_days": 30,
            "purchase_request": dummy_pdf(), "technical_specifications": dummy_pdf(),
            "terms_of_reference": dummy_pdf(), "approved_budget_document": dummy_pdf(),
            "bid_evaluation_criteria": dummy_pdf(),
        }, format="multipart")

    def test_new_project_gets_a_pc_code_from_the_backend(self):
        res = self._create()
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertRegex(res.data["code"], PC_CODE)

    def test_client_cannot_choose_the_code(self):
        from .tests import dummy_pdf
        res = self.client.post("/api/projects/", {
            "code": "P-2026-999", "name": "x", "type": "Goods", "category": "IT Equipment",
            "delivery_location": "HQ", "budget": "1000", "bidding_period_days": 10,
            "delivery_period_days": 30, "purchase_request": dummy_pdf(),
            "technical_specifications": dummy_pdf(), "terms_of_reference": dummy_pdf(),
            "approved_budget_document": dummy_pdf(), "bid_evaluation_criteria": dummy_pdf(),
        }, format="multipart")
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertRegex(res.data["code"], PC_CODE)

    def test_collisions_are_retried_with_a_fresh_code(self):
        taken = self._create().data["code"]
        with mock.patch("procurement.views.next_project_code",
                        side_effect=[taken] * 9 + ["PC-ABCD-EFGH-JKMN"]):
            res = self._create()
        self.assertEqual(res.status_code, status.HTTP_201_CREATED, res.data)
        self.assertEqual(res.data["code"], "PC-ABCD-EFGH-JKMN")

    def test_gives_up_after_the_retry_limit_instead_of_looping(self):
        taken = self._create().data["code"]
        before = Project.objects.count()
        with mock.patch("procurement.views.next_project_code", return_value=taken) as gen:
            with self.assertRaises(IntegrityError):
                self._create()
        self.assertEqual(gen.call_count, PROJECT_CODE_MAX_ATTEMPTS)
        self.assertEqual(Project.objects.count(), before)


class LegacyCodesStillVerifyTests(APITestCase):
    """Existing codes are anchored on-chain and are never rewritten. Each format
    must still resolve on the public trail and verify as intact."""

    def test_all_three_formats_resolve_and_verify(self):
        for code in ("P-2026-004", "PRC-2026-7K4M-Q9XT", "PC-7K4M-Q9XT-3HWD"):
            project = make_project(status=Project.Status.PUBLISHED)
            project.code = code
            project.save(update_fields=["code"])
            anchor = anchor_project(project, BlockchainAnchor.Stage.BIDDING_OPEN)
            self.assertEqual(verify_anchor(anchor)["status"], "match")

            res = self.client.get(f"/api/public/procurement/{code.lower()}/anchors/")
            self.assertEqual(res.status_code, status.HTTP_200_OK, code)
            self.assertEqual(res.data["code"], code)
            self.assertEqual(len(res.data["anchors"]), 1)


# ── Public blockchain trail ──────────────────────────────────────────────────
class PublicTrailHidesInternalProjectsTests(APITestCase):
    """Guessing an old sequential code used to reveal the name and status of
    projects nobody had published yet."""

    def test_internal_statuses_return_404(self):
        for st in (Project.Status.DRAFT, Project.Status.PENDING_HEAD, Project.Status.NEEDS_REVISION,
                   Project.Status.APPROVED, Project.Status.REJECTED):
            project = make_project(status=st)
            anchor_project(project, BlockchainAnchor.Stage.SUBMITTED)
            res = self.client.get(f"/api/public/procurement/{project.code}/anchors/")
            self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND, st)
            self.assertNotIn(project.name, str(res.data))

    def test_public_statuses_are_served(self):
        for st in (Project.Status.PUBLISHED, Project.Status.CLOSED, Project.Status.AWARDED):
            project = make_project(status=st)
            res = self.client.get(f"/api/public/procurement/{project.code}/anchors/")
            self.assertEqual(res.status_code, status.HTTP_200_OK, st)

    def test_hidden_project_looks_exactly_like_an_unknown_code(self):
        hidden = make_project(status=Project.Status.PENDING_HEAD)
        a = self.client.get(f"/api/public/procurement/{hidden.code}/anchors/")
        b = self.client.get("/api/public/procurement/PC-ZZZZ-ZZZZ-ZZZZ/anchors/")
        self.assertEqual((a.status_code, a.data), (b.status_code, b.data))


# ── File access ──────────────────────────────────────────────────────────────
class _MediaTestCase(APITestCase):
    """Uploads go to a throwaway folder, never backend/media."""

    def setUp(self):
        cache.clear()
        self._media = tempfile.mkdtemp()
        self._override = override_settings(MEDIA_ROOT=self._media)
        self._override.enable()

    def tearDown(self):
        self._override.disable()
        shutil.rmtree(self._media, ignore_errors=True)


class FileAccessMatrixTests(_MediaTestCase):
    """Who may download what (hardening decisions 2, 3 and 4)."""

    def setUp(self):
        super().setUp()
        self.admin, self.head = make_admin(), make_head()
        self.owner = make_supplier()
        self.rival = make_supplier()                       # verified, same category
        self.unverified = make_supplier(verified=False)
        self.other_cat = make_supplier(categories=["Furniture"])
        self.owner.valid_id = dummy_pdf("id.pdf")
        self.owner.save()

        self.project = make_project(status=Project.Status.PUBLISHED)
        for key in ("purchase_request", "approved_budget_document", "terms_of_reference",
                    "technical_specifications", "bid_evaluation_criteria"):
            setattr(self.project, key, dummy_pdf(f"{key}.pdf"))
        self.project.save()

        self.bid = Bid.objects.create(project=self.project, supplier=self.owner, amount=900,
                                      quotation_document=dummy_pdf("q.pdf"))
        self.att = BidAttachment.objects.create(bid=self.bid, file_name="a.pdf", file=dummy_pdf("a.pdf"))
        self.img = BidProductImage.objects.create(bid=self.bid, image=dummy_pdf("i.pdf"))

    def _get(self, user, path):
        self.client.force_authenticate(user=user)
        return self.client.get(path).status_code

    def test_head_gets_project_documents_but_no_supplier_or_bid_files(self):
        allowed = [f"/api/files/project/{self.project.pk}/{k}/" for k in (
            "purchase_request", "approved_budget_document", "terms_of_reference")]
        denied = [
            f"/api/files/supplier/{self.owner.pk}/valid_id/",
            f"/api/files/bid/{self.bid.pk}/quotation_document/",
            f"/api/files/attachment/{self.att.pk}/file/",
            f"/api/files/bidimage/{self.img.pk}/image/",
        ]
        for path in allowed:
            self.assertEqual(self._get(self.head, path), 200, path)
        for path in denied:
            self.assertEqual(self._get(self.head, path), 404, path)

    def test_eligible_supplier_gets_bidding_documents_only(self):
        base = f"/api/files/project/{self.project.pk}"
        for key in ("terms_of_reference", "technical_specifications", "bid_evaluation_criteria"):
            self.assertEqual(self._get(self.rival.user, f"{base}/{key}/"), 200, key)
        for key in ("purchase_request", "approved_budget_document"):
            self.assertEqual(self._get(self.rival.user, f"{base}/{key}/"), 404, key)

    def test_ineligible_suppliers_get_no_project_documents(self):
        path = f"/api/files/project/{self.project.pk}/terms_of_reference/"
        self.assertEqual(self._get(self.unverified.user, path), 404)
        self.assertEqual(self._get(self.other_cat.user, path), 404)
        Project.objects.filter(pk=self.project.pk).update(status=Project.Status.PENDING_HEAD)
        self.assertEqual(self._get(self.rival.user, path), 404)

    def test_supplier_project_listing_omits_internal_documents(self):
        self.client.force_authenticate(user=self.rival.user)
        project = self.client.get(f"/api/projects/{self.project.pk}/").data
        self.assertEqual({d["key"] for d in project["documents"]},
                         {"terms_of_reference", "technical_specifications", "bid_evaluation_criteria"})

    def test_rival_supplier_gets_nothing_of_the_owners(self):
        for path in (f"/api/files/supplier/{self.owner.pk}/valid_id/",
                     f"/api/files/bid/{self.bid.pk}/quotation_document/",
                     f"/api/files/attachment/{self.att.pk}/file/",
                     f"/api/files/bidimage/{self.img.pk}/image/"):
            self.assertEqual(self._get(self.rival.user, path), 404, path)

    def test_anonymous_gets_nothing_private(self):
        self.client.force_authenticate(user=None)
        for path in (f"/api/files/supplier/{self.owner.pk}/valid_id/",
                     f"/api/files/bid/{self.bid.pk}/quotation_document/",
                     f"/api/files/project/{self.project.pk}/terms_of_reference/"):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_owner_and_admin_can_read_the_bid_files(self):
        for user in (self.owner.user, self.admin):
            for path in (f"/api/files/bid/{self.bid.pk}/quotation_document/",
                         f"/api/files/attachment/{self.att.pk}/file/",
                         f"/api/files/bidimage/{self.img.pk}/image/"):
                self.assertEqual(self._get(user, path), 200, (user.role, path))


class OneTimeDownloadLinkTests(_MediaTestCase):
    def setUp(self):
        super().setUp()
        self.owner = make_supplier()
        self.rival = make_supplier()
        self.owner.valid_id = dummy_pdf("id.pdf")
        self.owner.save()
        self.path = f"/api/files/supplier/{self.owner.pk}/valid_id/"

    def _link(self, user=None):
        self.client.force_authenticate(user=user or self.owner.user)
        res = self.client.post(self.path + "link/")
        self.client.force_authenticate(user=None)
        return res

    def test_link_is_single_use(self):
        url = self._link().data["url"]
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_link_expires_after_two_minutes(self):
        res = self._link()
        self.assertEqual(res.data["expires_in"], 120)
        FileDownloadToken.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.client.get(res.data["url"]).status_code, 404)

    def test_link_is_only_issued_to_someone_who_may_read_the_file(self):
        self.assertEqual(self._link(self.rival.user).status_code, 404)
        self.assertFalse(FileDownloadToken.objects.exists())

    def test_link_requires_login(self):
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.post(self.path + "link/").status_code, 401)

    def test_link_is_bound_to_its_user_and_rechecked_on_use(self):
        url = self._link().data["url"]
        self.assertEqual(FileDownloadToken.objects.get().user, self.owner.user)
        # Access revoked between the click and the download -> refused.
        self.owner.user.is_active = False
        self.owner.user.save()
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_token_for_one_file_cannot_open_another(self):
        self.rival.valid_id = dummy_pdf("rival.pdf")
        self.rival.save()
        token = self._link().data["url"].split("t=")[1]
        res = self.client.get(f"/api/files/supplier/{self.rival.pk}/valid_id/?t={token}")
        self.assertEqual(res.status_code, 404)

    def test_raw_token_is_never_stored(self):
        token = self._link().data["url"].split("t=")[1]
        self.assertFalse(FileDownloadToken.objects.filter(token_hash=token).exists())
        self.assertEqual(len(FileDownloadToken.objects.get().token_hash), 64)

    def test_download_is_logged_with_user_file_and_ip(self):
        url = self._link().data["url"]
        self.client.get(url, REMOTE_ADDR="203.0.113.9")
        log = AuditLog.objects.get(action="file.downloaded")
        self.assertEqual(log.user, self.owner.user)
        self.assertEqual((log.entity_type, log.entity_id), ("supplier", str(self.owner.pk)))
        self.assertIn("valid_id", log.description)
        self.assertEqual(log.ip_address, "203.0.113.9")
        self.assertIsNotNone(log.created_at)

    def test_refusal_is_logged(self):
        self._link(self.rival.user)
        self.assertEqual(AuditLog.objects.get(action="file.download_denied").user, self.rival.user)

    def test_download_headers(self):
        res = self.client.get(self._link().data["url"])
        self.assertTrue(res["Content-Disposition"].startswith("attachment;"))
        self.assertEqual(res["X-Content-Type-Options"], "nosniff")
        self.assertIn("no-store", res["Cache-Control"])
        self.assertIn("private", res["Cache-Control"])


class PublicNoticeOfAwardTests(_MediaTestCase):
    def setUp(self):
        super().setUp()
        self.project = make_project(status=Project.Status.AWARDED)
        winner = make_supplier()
        bid = Bid.objects.create(project=self.project, supplier=winner, amount=900)
        self.award = Award.objects.create(
            project=self.project, supplier=winner, bid=bid, amount=900,
            notice_of_award=dummy_pdf("noa.pdf"), award_resolution=dummy_pdf("res.pdf"),
            notice_to_proceed=dummy_pdf("ntp.pdf"))

    def test_anyone_can_download_the_noa_of_an_awarded_project(self):
        res = self.client.get(f"/api/public/procurement/{self.project.code}/notice-of-award/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(b"".join(res.streaming_content), b"%PDF-1.4 fake")
        self.assertEqual(self.client.get(
            f"/api/files/award/{self.award.pk}/notice_of_award/").status_code, 200)
        self.assertTrue(AuditLog.objects.filter(action="file.downloaded", user=None).exists())

    def test_resolution_and_ntp_stay_private(self):
        for key in ("award_resolution", "notice_to_proceed"):
            res = self.client.get(f"/api/files/award/{self.award.pk}/{key}/")
            self.assertEqual(res.status_code, 404, key)

    def test_noa_is_not_public_before_the_project_is_awarded(self):
        Project.objects.filter(pk=self.project.pk).update(status=Project.Status.CLOSED)
        self.assertEqual(self.client.get(
            f"/api/public/procurement/{self.project.code}/notice-of-award/").status_code, 404)
        self.assertEqual(self.client.get(
            f"/api/files/award/{self.award.pk}/notice_of_award/").status_code, 404)

    def test_public_trail_links_the_noa_only_once_awarded(self):
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        self.assertTrue(res.data["notice_of_award_url"].endswith(
            f"/api/public/procurement/{self.project.code}/notice-of-award/"))
        Project.objects.filter(pk=self.project.pk).update(status=Project.Status.CLOSED)
        res = self.client.get(f"/api/public/procurement/{self.project.code}/anchors/")
        self.assertEqual(res.data["notice_of_award_url"], "")

    def test_head_can_read_every_award_document(self):
        self.client.force_authenticate(user=make_head())
        for key in ("award_resolution", "notice_of_award", "notice_to_proceed"):
            res = self.client.get(f"/api/files/award/{self.award.pk}/{key}/")
            self.assertEqual(res.status_code, 200, key)


# ── Uploads ──────────────────────────────────────────────────────────────────
def _jpeg_with_gps():
    """A real JPEG carrying a GPS block and a camera-owner tag."""
    buf = io.BytesIO()
    exif = Image.Exif()
    exif[0x013B] = "Juan Dela Cruz"                       # Artist
    exif[0x8825] = {1: "N", 2: (14.0, 35.0, 0.0)}        # GPS IFD
    Image.new("RGB", (8, 8), "red").save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def _docx(extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", "<w:document/>")
        for name in extra or ():
            z.writestr(name, "x")
    return buf.getvalue()


class UploadValidationTests(TestCase):
    def _check(self, validator, name, data):
        try:
            validator(SimpleUploadedFile(name, data))
            return "accepted"
        except ValidationError:
            return "rejected"

    def test_dangerous_types_and_double_extensions_are_rejected(self):
        for validator, name, data in [
            (validate_upload, "x.pdf.exe", b"MZ"),
            (validate_upload, "x.svg", b"<svg onload=alert(1)>"),
            (validate_upload, "x.html", b"<script>"),
            (validate_upload, "invoice.exe.pdf", b"%PDF-1.4"),
            (validate_upload, "photo.html.png", b"\x89PNG\r\n\x1a\n"),
            (validate_bid_upload, "quote.js.docx", _docx()),
        ]:
            self.assertEqual(self._check(validator, name, data), "rejected", name)

    def test_ordinary_dotted_names_are_fine(self):
        self.assertEqual(self._check(validate_upload, "Q3.2026.report.pdf", b"%PDF-1.4"), "accepted")

    def test_fake_office_files_are_rejected(self):
        self.assertEqual(self._check(validate_bid_upload, "x.docx", b"MZ renamed exe"), "rejected")
        self.assertEqual(self._check(validate_bid_upload, "x.xlsx", b"<html><script>"), "rejected")
        self.assertEqual(self._check(validate_bid_upload, "x.doc", b"<html>"), "rejected")
        self.assertEqual(self._check(validate_bid_upload, "x.xlsx", _docx()), "rejected")   # word/, not xl/

    def test_macro_documents_are_rejected(self):
        self.assertEqual(self._check(validate_bid_upload, "m.docx", _docx(["word/vbaProject.bin"])), "rejected")

    def test_genuine_office_file_is_accepted(self):
        self.assertEqual(self._check(validate_bid_upload, "quotation.docx", _docx()), "accepted")

    def test_image_with_a_valid_header_but_garbage_body_is_rejected(self):
        self.assertEqual(self._check(validate_upload, "x.png", b"\x89PNG\r\n\x1a\n<script>"), "rejected")

    def test_oversized_files_are_rejected(self):
        big = b"%PDF-1.4" + b"0" * (5 * 1024 * 1024)
        self.assertEqual(self._check(validate_upload, "big.pdf", big), "rejected")


class StoredFileNameTests(_MediaTestCase):
    def test_new_uploads_get_random_names_and_keep_the_original_in_the_db(self):
        supplier = make_supplier()
        supplier.valid_id = dummy_pdf("Juan_Dela_Cruz_Passport.pdf")
        supplier.save()
        self.assertRegex(supplier.valid_id.name, r"^supplier_docs/[0-9a-f]{32}\.pdf$")
        self.assertNotIn("Juan", supplier.valid_id.name)
        self.assertNotIn(str(supplier.pk) + "/", supplier.valid_id.name)
        supplier.refresh_from_db()
        self.assertEqual(supplier.original_filenames["valid_id"], "Juan_Dela_Cruz_Passport.pdf")

    def test_bid_documents_no_longer_use_guessable_folders(self):
        bid = Bid.objects.create(project=make_project(), supplier=make_supplier(), amount=1,
                                 quotation_document=dummy_pdf("My Quotation.pdf"))
        self.assertRegex(bid.quotation_document.name, r"^bid_documents/[0-9a-f]{32}\.pdf$")
        self.assertEqual(bid.original_filenames["quotation_document"], "My_Quotation.pdf")

    def test_download_is_offered_under_the_original_name(self):
        supplier = make_supplier()
        supplier.valid_id = dummy_pdf("Passport.pdf")
        supplier.save()
        self.client.force_authenticate(user=supplier.user)
        res = self.client.get(f"/api/files/supplier/{supplier.pk}/valid_id/")
        self.assertIn('filename="Passport.pdf"', res["Content-Disposition"])

    def test_update_fields_saves_still_record_the_name(self):
        supplier = make_supplier()
        supplier.mayors_permit = dummy_pdf("permit.pdf")
        supplier.save(update_fields=["mayors_permit"])
        supplier.refresh_from_db()
        self.assertEqual(supplier.original_filenames.get("mayors_permit"), "permit.pdf")

    def test_existing_files_keep_their_stored_name(self):
        supplier = make_supplier()
        Supplier.objects.filter(pk=supplier.pk).update(valid_id="supplier_docs/7/legacy_ab12cd34.pdf")
        supplier.refresh_from_db()
        supplier.company = "Renamed Co."
        supplier.save()
        supplier.refresh_from_db()
        self.assertEqual(supplier.valid_id.name, "supplier_docs/7/legacy_ab12cd34.pdf")


class ImageMetadataTests(_MediaTestCase):
    def test_gps_and_owner_tags_are_removed_from_uploaded_images(self):
        supplier = make_supplier()
        supplier.valid_id = SimpleUploadedFile("id.jpg", _jpeg_with_gps(), content_type="image/jpeg")
        supplier.save()
        with Image.open(supplier.valid_id.path) as img:
            exif = img.getexif()
            self.assertNotIn(0x8825, exif)
            self.assertNotIn(0x013B, exif)
            self.assertEqual(img.size, (8, 8))

    def test_product_images_are_stripped_too(self):
        project = make_project()
        supplier = make_supplier()
        bid = Bid.objects.create(project=project, supplier=supplier, amount=1)
        from .views import save_product_images
        upload = SimpleUploadedFile("p.jpg", _jpeg_with_gps(), content_type="image/jpeg")
        save_product_images(bid, [(upload, ".jpg", "")])
        with Image.open(bid.product_images.get().image.path) as img:
            self.assertNotIn(0x8825, img.getexif())

    def test_anchored_hash_is_of_the_cleaned_file_and_still_verifies(self):
        project = make_project(status=Project.Status.PENDING_HEAD)
        project.purchase_request = dummy_pdf("pr.pdf")
        project.approved_budget_document = SimpleUploadedFile(
            "abc.jpg", _jpeg_with_gps(), content_type="image/jpeg")
        project.save()
        anchor = anchor_project(project, BlockchainAnchor.Stage.HEAD_APPROVED)
        self.assertEqual(verify_anchor(anchor, deep=True)["status"], "match")


# ── Encryption at rest ───────────────────────────────────────────────────────
KEY_A = Fernet.generate_key().decode()
KEY_B = Fernet.generate_key().decode()
SECRET = b"%PDF-1.4 TIN 123-456-789 Juan Dela Cruz"


def _stored_bytes(field_file):
    with open(field_file.path, "rb") as f:
        return f.read()


@override_settings(FILE_ENCRYPTION_KEY=KEY_A, FILE_ENCRYPTION_OLD_KEYS="")
class SupplierDocumentEncryptionTests(_MediaTestCase):
    def setUp(self):
        super().setUp()
        self.supplier = make_supplier()

    def _upload(self, key="valid_id"):
        setattr(self.supplier, key, SimpleUploadedFile("id.pdf", SECRET))
        self.supplier.save()

    def test_registration_documents_are_ciphertext_at_rest(self):
        self._upload()
        stored = _stored_bytes(self.supplier.valid_id)
        self.assertTrue(stored.startswith(MAGIC))
        self.assertNotIn(b"Juan", stored)
        self.assertNotIn(b"123-456-789", stored)

    def test_authorised_download_is_decrypted(self):
        self._upload()
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.get(f"/api/files/supplier/{self.supplier.pk}/valid_id/")
        self.assertEqual(b"".join(res.streaming_content), SECRET)

    def test_category_licenses_are_encrypted_too(self):
        from .models import SupplierCategoryDocument
        row = SupplierCategoryDocument.objects.create(
            supplier=self.supplier, key="fda_lto", file=SimpleUploadedFile("lto.pdf", SECRET))
        self.assertTrue(_stored_bytes(row.file).startswith(MAGIC))

    def test_legacy_unencrypted_files_still_open(self):
        with override_settings(FILE_ENCRYPTION_KEY=""):
            self._upload()
        self.assertEqual(_stored_bytes(self.supplier.valid_id), SECRET)
        self.client.force_authenticate(user=self.supplier.user)
        res = self.client.get(f"/api/files/supplier/{self.supplier.pk}/valid_id/")
        self.assertEqual(b"".join(res.streaming_content), SECRET)

    def test_files_under_a_retired_key_still_open_after_rotation(self):
        self._upload()
        with override_settings(FILE_ENCRYPTION_KEY=KEY_B, FILE_ENCRYPTION_OLD_KEYS=KEY_A):
            self.client.force_authenticate(user=self.supplier.user)
            res = self.client.get(f"/api/files/supplier/{self.supplier.pk}/valid_id/")
            self.assertEqual(b"".join(res.streaming_content), SECRET)

    def test_anchored_document_types_are_never_encrypted(self):
        project = make_project()
        bid = Bid.objects.create(project=project, supplier=self.supplier, amount=1,
                                 quotation_document=SimpleUploadedFile("q.pdf", SECRET))
        project.terms_of_reference = SimpleUploadedFile("tor.pdf", SECRET)
        project.save()
        self.assertEqual(_stored_bytes(bid.quotation_document), SECRET)
        self.assertEqual(_stored_bytes(project.terms_of_reference), SECRET)

    def test_command_dry_run_changes_nothing_and_apply_encrypts_legacy_files(self):
        with override_settings(FILE_ENCRYPTION_KEY=""):
            self._upload()
        call_command("encrypt_supplier_documents", stdout=io.StringIO())
        self.assertEqual(_stored_bytes(self.supplier.valid_id), SECRET)
        call_command("encrypt_supplier_documents", "--apply", stdout=io.StringIO())
        self.supplier.refresh_from_db()
        stored = _stored_bytes(self.supplier.valid_id)
        self.assertTrue(stored.startswith(MAGIC))
        self.assertEqual(decrypt_bytes(stored), SECRET)

    def test_command_rotates_to_the_new_key(self):
        self._upload()
        with override_settings(FILE_ENCRYPTION_KEY=KEY_B, FILE_ENCRYPTION_OLD_KEYS=KEY_A):
            call_command("encrypt_supplier_documents", "--apply", stdout=io.StringIO())
        token = _stored_bytes(self.supplier.valid_id)[len(MAGIC):]
        self.assertEqual(Fernet(KEY_B.encode()).decrypt(token), SECRET)
        with self.assertRaises(InvalidToken):
            Fernet(KEY_A.encode()).decrypt(token)


class StorageSafetyCheckTests(TestCase):
    S3 = {"default": {"BACKEND": "storages.backends.s3.S3Storage"},
          "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"}}

    def _ids(self):
        return {cid for cid, _, _ in storage_problems()}

    def test_safe_s3_settings_pass(self):
        with override_settings(STORAGES=self.S3, AWS_DEFAULT_ACL=None, AWS_QUERYSTRING_AUTH=True,
                               AWS_QUERYSTRING_EXPIRE=60, AWS_S3_CUSTOM_DOMAIN=None):
            self.assertEqual(self._ids(), set())

    def test_public_acl_unsigned_urls_and_custom_domain_are_errors(self):
        with override_settings(STORAGES=self.S3, AWS_DEFAULT_ACL="public-read",
                               AWS_QUERYSTRING_AUTH=False, AWS_QUERYSTRING_EXPIRE=86400,
                               AWS_S3_CUSTOM_DOMAIN="cdn.example.com"):
            self.assertEqual(self._ids(), {"procurement.E001", "procurement.E002",
                                           "procurement.E003", "procurement.E004"})

    def test_errors_are_reported_as_system_check_errors(self):
        with override_settings(STORAGES=self.S3, AWS_DEFAULT_ACL="public-read",
                               AWS_QUERYSTRING_AUTH=True, AWS_QUERYSTRING_EXPIRE=60,
                               AWS_S3_CUSTOM_DOMAIN=None):
            errors = check_storage_safety(None)
        self.assertTrue(any(e.id == "procurement.E001" and e.level >= checks.ERROR for e in errors))

    def test_missing_encryption_key_is_flagged_in_production(self):
        with override_settings(DEBUG=False, RUNNING_TESTS=False, FILE_ENCRYPTION_KEY=""):
            self.assertEqual([p[0] for p in encryption_problems()], ["procurement.W001"])


class MigrateMediaToBucketTests(TestCase):
    def setUp(self):
        self.source = tempfile.mkdtemp()
        self.bucket = tempfile.mkdtemp()
        self.target = FileSystemStorage(location=self.bucket)
        self.supplier = make_supplier()
        # A row pointing at a file that only exists on the old local disk, one
        # already in the bucket, and one that is lost everywhere.
        self.data = b"%PDF-1.4 anchored quotation"
        os.makedirs(os.path.join(self.source, "bid_documents", "quotations"))
        with open(os.path.join(self.source, "bid_documents", "quotations", "q.pdf"), "wb") as f:
            f.write(self.data)
        self.target.save("supplier_docs/already.pdf", ContentFile(b"x"))
        project = make_project()
        Bid.objects.create(project=project, supplier=self.supplier, amount=1)
        Bid.objects.filter(supplier=self.supplier).update(
            quotation_document="bid_documents/quotations/q.pdf",
            technical_document="bid_documents/technical/lost.pdf")
        Supplier.objects.filter(pk=self.supplier.pk).update(valid_id="supplier_docs/already.pdf")

    def tearDown(self):
        shutil.rmtree(self.source, ignore_errors=True)
        shutil.rmtree(self.bucket, ignore_errors=True)

    def _run(self, *args):
        out = io.StringIO()
        with mock.patch(
                "procurement.management.commands.migrate_media_to_bucket.Command.target_storage",
                return_value=self.target):
            call_command("migrate_media_to_bucket", "--source", self.source, *args, stdout=out)
        return out.getvalue()

    def test_dry_run_reports_and_copies_nothing(self):
        out = self._run()
        self.assertIn("WOULD COPY", out)
        self.assertIn("MISSING EVERYWHERE", out)
        self.assertFalse(self.target.exists("bid_documents/quotations/q.pdf"))

    def test_apply_copies_byte_for_byte_under_the_same_name(self):
        out = self._run("--apply")
        self.assertIn("Copied: 1", out)
        with self.target.open("bid_documents/quotations/q.pdf", "rb") as f:
            self.assertEqual(f.read(), self.data)
        bid = Bid.objects.get(supplier=self.supplier)
        self.assertEqual(bid.quotation_document.name, "bid_documents/quotations/q.pdf")

    def test_files_already_in_the_bucket_are_left_alone(self):
        out = self._run("--apply")
        self.assertIn("Already in bucket: 1", out)
        with self.target.open("supplier_docs/already.pdf", "rb") as f:
            self.assertEqual(f.read(), b"x")


class EncryptedBackupTests(TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        make_supplier()

    def tearDown(self):
        shutil.rmtree(self.out, ignore_errors=True)

    @override_settings(FILE_ENCRYPTION_KEY=KEY_A)
    def test_backup_is_encrypted_and_decrypts_for_restore(self):
        call_command("backup_db", "-o", self.out, stdout=io.StringIO())
        [name] = os.listdir(self.out)
        self.assertTrue(name.endswith(".json.enc"))
        path = os.path.join(self.out, name)
        with open(path, "rb") as f:
            raw = f.read()
        self.assertNotIn(b"supplier0@example.com", raw)
        call_command("backup_db", "--decrypt", path, stdout=io.StringIO(), stderr=io.StringIO())
        with open(path[:-4], "rb") as f:
            self.assertIn(b"supplier0@example.com", f.read())

    @override_settings(FILE_ENCRYPTION_KEY="")
    def test_unencrypted_backup_warns(self):
        err = io.StringIO()
        call_command("backup_db", "-o", self.out, stdout=io.StringIO(), stderr=err)
        self.assertIn("NOT encrypted", err.getvalue())


# ── Security headers ─────────────────────────────────────────────────────────
class SecurityHeaderTests(_MediaTestCase):
    def test_api_responses_carry_the_security_headers(self):
        res = self.client.get("/api/public/procurement/")
        csp = res["Content-Security-Policy"]
        for directive in ("default-src 'self'", "script-src 'self'", "object-src 'none'",
                          "frame-ancestors 'none'", "base-uri 'none'"):
            self.assertIn(directive, csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertEqual(res["X-Frame-Options"], "DENY")
        self.assertEqual(res["X-Content-Type-Options"], "nosniff")
        self.assertEqual(res["Referrer-Policy"], "strict-origin-when-cross-origin")
        self.assertIn("camera=()", res["Permissions-Policy"])

    def test_file_downloads_keep_their_sandbox_policy(self):
        supplier = make_supplier()
        supplier.valid_id = dummy_pdf("id.pdf")
        supplier.save()
        self.client.force_authenticate(user=supplier.user)
        res = self.client.get(f"/api/files/supplier/{supplier.pk}/valid_id/")
        self.assertEqual(res["Content-Security-Policy"], "default-src 'none'; sandbox")

    @override_settings(SECURE_HSTS_SECONDS=31536000, SECURE_HSTS_INCLUDE_SUBDOMAINS=True)
    def test_hsts_is_one_year_with_subdomains_over_https(self):
        res = self.client.get("/api/public/procurement/", secure=True)
        self.assertEqual(res["Strict-Transport-Security"], "max-age=31536000; includeSubDomains")
