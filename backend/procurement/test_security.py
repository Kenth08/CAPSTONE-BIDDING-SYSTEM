"""Tests for the security-hardening work (see SECURITY.md).

Grouped by protection so a failure points straight at the guarantee that broke:
public bidding IDs, the public blockchain trail, file access, uploads, storage,
authentication and audit logging. Shared fixtures come from tests.py.
"""
import re
from unittest import mock

from django.core.cache import cache
from django.db import IntegrityError
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APITestCase

from .blockchain import anchor_project, verify_anchor
from .models import BlockchainAnchor, Project
from .tests import make_admin, make_project
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
