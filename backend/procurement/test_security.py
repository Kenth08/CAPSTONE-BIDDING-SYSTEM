"""Tests for the security-hardening work (see SECURITY.md).

Grouped by protection so a failure points straight at the guarantee that broke:
public bidding IDs, the public blockchain trail, file access, uploads, storage,
authentication and audit logging. Shared fixtures come from tests.py.
"""
import re
import shutil
import tempfile
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from accounts.models import AuditLog

from .blockchain import anchor_project, verify_anchor
from .models import (
    Award,
    Bid,
    BidAttachment,
    BidProductImage,
    BlockchainAnchor,
    FileDownloadToken,
    Project,
)
from .tests import dummy_pdf, make_admin, make_head, make_project, make_supplier
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
