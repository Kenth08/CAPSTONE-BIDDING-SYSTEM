"""Official post-award document generation (BAC Resolution, NOA, NTP).

The documents are built from the award record itself — supplier, procurement,
amount, dates — so the Admin never retypes what the system already knows, and a
typo can't put a different amount on the notice than the one that was awarded.

CRITICAL RULE: generate ONCE, store the file, and hash the STORED file.

A PDF embeds a creation timestamp, so regenerating the "same" document produces
different bytes and therefore a different SHA-256 every time. If the system
regenerated on each download, the hash anchored on-chain could never be
reproduced and verification would be meaningless — worse than not anchoring at
all, because it would *look* verified. So the generate endpoint writes the file
to storage once and every later download serves those exact bytes.

Currency is written as "PHP" rather than "₱": the peso sign is absent from the
PDF standard fonts, and spelling it out is what Philippine government issuances
do anyway.
"""
from decimal import Decimal
from io import BytesIO

from django.utils import timezone
from fpdf import FPDF

# Shown in the signature block. Configurable later without touching the layout.
ISSUING_OFFICE = "Bids and Awards Committee"
ISSUING_ENTITY = "Office of the Procuring Entity"


# The PDF standard fonts are latin-1 only, so anything outside that range (an
# em-dash, a curly quote, the peso sign, a supplier name with unusual
# characters) would raise at render time. Everything written to a document goes
# through _safe() so real-world data can never break document generation.
_TEXT_REPLACEMENTS = {
    "—": "-", "–": "-",            # em / en dash
    "‘": "'", "’": "'",            # curly single quotes
    "“": '"', "”": '"',            # curly double quotes
    "…": "...", "•": "-",          # ellipsis, bullet
    "₱": "PHP ",                        # peso sign
    " ": " ",                           # non-breaking space
}


def _safe(text):
    value = str(text)
    for bad, good in _TEXT_REPLACEMENTS.items():
        value = value.replace(bad, good)
    # Anything still unrepresentable becomes "?" rather than an exception.
    return value.encode("latin-1", "replace").decode("latin-1")


def peso(amount):
    """"PHP 100,000.00" — formal, and avoids the peso glyph the base PDF fonts
    don't carry."""
    try:
        return f"PHP {Decimal(amount):,.2f}"
    except Exception:
        return f"PHP {amount}"


def _fmt_date(value):
    if value is None:
        return "____________"
    try:
        return value.strftime("%d %B %Y")
    except AttributeError:
        return str(value)


class _OfficialDocument(FPDF):
    """Shared page furniture: a letterhead and a page footer."""

    def __init__(self, title):
        super().__init__(format="A4")
        self.doc_title = title
        self.set_auto_page_break(auto=True, margin=20)
        self.set_margins(20, 18, 20)

    def header(self):
        self.line_out("REPUBLIC OF THE PHILIPPINES", height=7, bold=True, size=13, align="C")
        self.line_out(ISSUING_ENTITY, align="C")
        self.line_out(ISSUING_OFFICE, align="C")
        self.ln(4)
        self.set_draw_color(120, 120, 120)
        self.line(20, self.get_y(), 190, self.get_y())
        self.ln(6)
        self.line_out(self.doc_title, height=8, bold=True, size=14, align="C")
        self.ln(4)

    def footer(self):
        self.set_y(-16)
        self.set_font("Helvetica", "I", 7.5)
        self.set_text_color(110, 110, 110)
        self.multi_cell(
            0, 3.5,
            _safe(
                "This document is recorded on a public blockchain ledger. Its authenticity can "
                "be verified at any time on the Public Results page using the procurement "
                "reference above - no account required."
            ),
            align="C",
        )
        self.set_text_color(0, 0, 0)

    # ── Small helpers so each document reads as prose, not layout code ───────
    # Every one sanitizes its text (see _safe) so live data can't break a render.
    def line_out(self, text, *, width=0, height=5, bold=False, size=10, align="L", wrap=False):
        self.set_font("Helvetica", "B" if bold else "", size)
        if wrap:
            self.multi_cell(width, height, _safe(text), align=align, new_x="LMARGIN", new_y="NEXT")
        else:
            self.cell(width, height, _safe(text), align=align, new_x="LMARGIN", new_y="NEXT")

    def field(self, label, value):
        self.set_font("Helvetica", "B", 10)
        self.cell(32, 6, _safe(label))
        self.set_font("Helvetica", "", 10)
        self.multi_cell(0, 6, _safe(value), new_x="LMARGIN", new_y="NEXT")

    def para(self, text, gap=3):
        self.set_font("Helvetica", "", 10.5)
        self.multi_cell(0, 5.6, _safe(text), new_x="LMARGIN", new_y="NEXT")
        self.ln(gap)

    def signature_block(self, role):
        self.ln(10)
        self.line_out("Very truly yours,", height=5.6, size=10.5)
        self.ln(12)
        self.line_out("______________________________", width=80)
        self.line_out(role, width=80, bold=True)

    def conforme_block(self, supplier):
        self.ln(8)
        self.line_out("CONFORME:", bold=True)
        self.ln(10)
        self.set_font("Helvetica", "", 10)
        self.cell(90, 5, "______________________________", border=0)
        self.cell(0, 5, "Date: ______________", new_x="LMARGIN", new_y="NEXT")
        self.line_out(f"Authorized Representative, {supplier}", width=90)

    def output_bytes(self):
        buf = BytesIO()
        self.output(buf)
        return buf.getvalue()


def _reference_block(pdf, award, issued_on):
    pdf.field("Date:", _fmt_date(issued_on))
    pdf.field("Reference:", award.project.code)
    pdf.ln(3)


def build_notice_of_award(award, issued_on=None):
    """Notice of Award — tells the winner they won and starts their clock for
    posting a performance security."""
    issued_on = issued_on or timezone.localdate()
    pdf = _OfficialDocument("NOTICE OF AWARD")
    pdf.add_page()
    _reference_block(pdf, award, issued_on)

    pdf.field("To:", award.supplier.company)
    if award.supplier.company_address:
        pdf.field("", award.supplier.company_address)
    pdf.ln(3)
    pdf.para("Sir/Madam:")
    pdf.para(
        f"We are pleased to notify you that your bid in the amount of {peso(award.amount)} "
        f"for the procurement of \"{award.project.name}\" ({award.project.code}) has been "
        "found to be the Lowest Calculated Responsive Bid, and the contract is hereby "
        "AWARDED to your company."
    )
    pdf.para(
        "You are required to post the required Performance Security and to enter into "
        "contract with this Office within ten (10) calendar days from your receipt of this "
        "Notice, in accordance with Republic Act No. 9184 and its Implementing Rules and "
        "Regulations."
    )
    pdf.para(
        "Please signify your conformity by signing the space provided below and returning "
        "a copy of this Notice to this Office."
    )
    pdf.signature_block("Head of the Procuring Entity")
    pdf.conforme_block(award.supplier.company)
    return pdf.output_bytes()


def build_notice_to_proceed(award, issued_on=None):
    """Notice to Proceed — authorises the supplier to start, and fixes the date
    the delivery period is counted from."""
    issued_on = issued_on or timezone.localdate()
    pdf = _OfficialDocument("NOTICE TO PROCEED")
    pdf.add_page()
    _reference_block(pdf, award, issued_on)

    pdf.field("To:", award.supplier.company)
    pdf.ln(3)
    pdf.para("Sir/Madam:")

    period = award.project.delivery_period_days
    period_text = (
        f"within {period} calendar days from your receipt of this Notice"
        if period else "within the period stipulated in the contract"
    )
    expected = award.project.expected_delivery_date
    pdf.para(
        f"Pursuant to the Notice of Award issued in your favour for \"{award.project.name}\" "
        f"({award.project.code}) in the amount of {peso(award.amount)}, you are hereby "
        f"authorized to PROCEED with the delivery and performance of the contract effective "
        f"{_fmt_date(issued_on)}."
    )
    pdf.para(
        f"Delivery shall be completed {period_text}"
        + (f", on or before {_fmt_date(expected)}." if expected else ".")
    )
    if award.project.delivery_location:
        pdf.para(f"Place of delivery: {award.project.delivery_location}.")
    pdf.para(
        "Failure to comply within the period stated shall subject your company to the "
        "liquidated damages and other remedies provided under the contract and Republic "
        "Act No. 9184."
    )
    pdf.signature_block("Head of the Procuring Entity")
    pdf.conforme_block(award.supplier.company)
    return pdf.output_bytes()


def build_bac_resolution(award, issued_on=None):
    """BAC Resolution recommending the award — the deliberative record behind
    the decision."""
    issued_on = issued_on or timezone.localdate()
    pdf = _OfficialDocument("BAC RESOLUTION")
    pdf.add_page()
    _reference_block(pdf, award, issued_on)

    pdf.line_out(
        f"RESOLUTION RECOMMENDING THE AWARD OF CONTRACT FOR \"{award.project.name.upper()}\" "
        f"({award.project.code}) TO {award.supplier.company.upper()}",
        height=5.6, bold=True, size=10.5, align="C", wrap=True,
    )
    pdf.ln(5)

    bid_count = award.project.bids.count()
    pdf.para(
        f"WHEREAS, the Bids and Awards Committee conducted the procurement of "
        f"\"{award.project.name}\" with an Approved Budget for the Contract of "
        f"{peso(award.project.budget)};"
    )
    pdf.para(
        f"WHEREAS, {bid_count} bid(s) were received and evaluated in accordance with the "
        "eligibility and technical requirements of the procurement;"
    )
    pdf.para(
        f"WHEREAS, the bid of {award.supplier.company} in the amount of {peso(award.amount)} "
        "was determined to be the Lowest Calculated Responsive Bid;"
    )
    pdf.para(
        "WHEREAS, every stage of this procurement has been recorded on a public blockchain "
        "ledger, and the record of each decision can be independently verified;"
    )
    pdf.para(
        f"NOW THEREFORE, the Bids and Awards Committee hereby RESOLVES, as it is hereby "
        f"RESOLVED, to recommend the award of the contract for \"{award.project.name}\" to "
        f"{award.supplier.company} in the amount of {peso(award.amount)}."
    )
    pdf.para(f"RESOLVED at this {_fmt_date(issued_on)}.")

    pdf.ln(8)
    pdf.line_out("BIDS AND AWARDS COMMITTEE", bold=True)
    pdf.ln(10)
    pdf.set_font("Helvetica", "", 10)
    for role in ("Chairperson", "Vice-Chairperson", "Member"):
        pdf.cell(85, 5, "______________________________", border=0)
        pdf.cell(0, 5, role, new_x="LMARGIN", new_y="NEXT")
        pdf.ln(6)
    return pdf.output_bytes()


# Which builder produces which document (keys match AWARD_DOCUMENT_FIELDS).
DOCUMENT_BUILDERS = {
    "award_resolution": build_bac_resolution,
    "notice_of_award": build_notice_of_award,
    "notice_to_proceed": build_notice_to_proceed,
}
