"""Encrypted openings of salted commitments.

A commitment hides private values on-chain: C = SHA-256(canonical({kind, private
fields, salt})). Its "opening" is that exact object, and without it nobody can
ever prove what was committed. So each one is kept, encrypted and written once,
for as long as its anchor exists.

KEYS
----
COMMITMENT_KEY        the current key: encrypts, and decrypts
COMMITMENT_OLD_KEYS   comma-separated retired keys: decrypt only

Separate from FILE_ENCRYPTION_KEY, and there is no plaintext fallback: with no
key, storing an opening raises. A key is only ever identified by its fingerprint
(the first 8 hex characters of its SHA-256).

Losing a key makes its openings permanently unopenable. That is reported as
"opening unavailable", never as a mismatch: public integrity is unaffected, since
the public fields and data_hash still verify.

WHAT IS ENCRYPTED
-----------------
Canonical JSON {anchor_id, kind, opening}. On decryption the row must agree with
it, and the opening must hash to the row's commitment. The commitment check is
what catches a swap between two bid leaves of one evaluation: they share both
anchor_id and kind.

The salt is never written to logs, audit text or error messages.
"""
import hashlib
import json
import logging
import secrets

from django.conf import settings
from django.db import IntegrityError, transaction

from accounts.audit import log_action

from .canonical import NonCanonicalPayload, hash_payload
from .models import CommitmentOpening, Supplier
from .payload_v3 import (
    KIND_AWARD_DOCUMENT,
    KIND_AWARD_PRIVATE,
    KIND_BID_LEAF,
    KIND_EVALUATION,
    validate_opening,
)

logger = logging.getLogger(__name__)

MATCH = "match"
MISMATCH = "mismatch"
UNAVAILABLE = "unavailable"

# A verifier accepts only the kind its context expects: which anchor payload may
# hold a commitment of each kind, and under which key.
_ANCHORED_IN = {
    KIND_BID_LEAF: (KIND_EVALUATION, "leaves"),
    KIND_AWARD_PRIVATE: (KIND_AWARD_DOCUMENT, "private_commitment"),
}


class OpeningsNotConfigured(Exception):
    """COMMITMENT_KEY is not set, or a configured key is not a valid key."""


class OpeningAlreadyStored(Exception):
    """This commitment already has an opening, or its salt is already in use."""


class OpeningUnavailable(Exception):
    """No key available here can decrypt this opening."""


class OpeningMismatch(Exception):
    """The decrypted opening does not belong to this row."""


class OpeningAccessDenied(Exception):
    """This user may not read this opening."""


# ── Keys ─────────────────────────────────────────────────────────────────────

def _current_key():
    return (getattr(settings, "COMMITMENT_KEY", "") or "").strip()


def _old_keys():
    raw = getattr(settings, "COMMITMENT_OLD_KEYS", "") or ""
    return [key.strip() for key in raw.split(",") if key.strip()]


def key_fingerprint(key):
    return hashlib.sha256(key.encode()).hexdigest()[:8]


def commitment_key_problems(*, required=True):
    """Why the configured keys can't be used, as messages that reveal nothing
    about them. `required=False` accepts having no COMMITMENT_KEY at all."""
    from cryptography.fernet import Fernet

    problems = []
    if not _current_key():
        if required:
            problems.append("COMMITMENT_KEY is not set: commitment openings could not be stored.")
    else:
        try:
            Fernet(_current_key().encode())
        except ValueError:
            problems.append("COMMITMENT_KEY is not a valid Fernet key.")
    for position, key in enumerate(_old_keys(), start=1):
        try:
            Fernet(key.encode())
        except ValueError:
            problems.append(f"COMMITMENT_OLD_KEYS entry {position} is not a valid Fernet key.")
    return problems


def commitment_key_fingerprints():
    """[(setting name, fingerprint)] of the configured keys, for the start-up log."""
    pairs = [("COMMITMENT_KEY", key_fingerprint(_current_key()))] if _current_key() else []
    return pairs + [("COMMITMENT_OLD_KEYS", key_fingerprint(key)) for key in _old_keys()]


def _keyring():
    """A MultiFernet of every configured key, current first. Raises
    OpeningsNotConfigured without a usable current key."""
    from cryptography.fernet import Fernet, MultiFernet

    problems = commitment_key_problems()
    if problems:
        raise OpeningsNotConfigured(" ".join(problems))
    return MultiFernet([Fernet(key.encode()) for key in [_current_key(), *_old_keys()]])


# ── Salts and commitments ────────────────────────────────────────────────────

def new_salt():
    """A fresh 256-bit salt from the operating system's secure generator, as 64
    lowercase hex characters. One per commitment, never derived from anything."""
    return secrets.token_bytes(32).hex()


def salt_fingerprint(salt):
    return hashlib.sha256(b"commitment-salt/3:" + salt.encode("ascii")).hexdigest()


def opening_matches(opening, commitment):
    """Does this opening reproduce this commitment? False, not an error, for any
    opening outside the schema, such as an empty salt."""
    try:
        validate_opening(opening)
    except NonCanonicalPayload:
        return False
    return hash_payload(opening) == commitment


# ── Storing and reading ──────────────────────────────────────────────────────

def _plaintext(anchor_id, kind, opening):
    return json.dumps({"anchor_id": anchor_id, "kind": kind, "opening": opening},
                      sort_keys=True, separators=(",", ":")).encode("ascii")


def store_opening(anchor, subject_id, opening, supplier=None):
    """Encrypt `opening` and keep it, once. Returns the row.

    Raises OpeningsNotConfigured rather than store plaintext, and
    OpeningAlreadyStored rather than touch what exists. A writer must therefore
    create the anchor and its openings in one transaction, before any signing:
    an anchor must never reach the chain without its openings."""
    validate_opening(opening)
    kind = opening["kind"]
    token = _keyring().encrypt(_plaintext(anchor.id, kind, opening)).decode("ascii")
    try:
        with transaction.atomic():
            return CommitmentOpening.objects.create(
                anchor=anchor, kind=kind, subject_id=subject_id, supplier=supplier,
                commitment=hash_payload(opening), salt_fingerprint=salt_fingerprint(opening["salt"]),
                ciphertext=token, key_fingerprint=key_fingerprint(_current_key()),
            )
    except IntegrityError:
        raise OpeningAlreadyStored(
            f"Anchor {anchor.id} already has this {kind} opening, or its salt is in use.") from None


def decrypt_opening(row):
    """The opening held by `row`. Raises OpeningUnavailable (no key opens it) or
    OpeningMismatch (it does not belong to this row)."""
    from cryptography.fernet import InvalidToken

    try:
        plaintext = _keyring().decrypt(row.ciphertext.encode("ascii"))
    except (InvalidToken, OpeningsNotConfigured, ValueError):
        raise OpeningUnavailable(f"Opening {row.pk} is unavailable: no key here can decrypt it.") from None
    try:
        wrapped = json.loads(plaintext)
        opening = wrapped["opening"]
        same_row = wrapped["anchor_id"] == row.anchor_id and wrapped["kind"] == row.kind
        same_salt = salt_fingerprint(opening["salt"]) == row.salt_fingerprint
    except (ValueError, KeyError, TypeError, AttributeError):
        raise OpeningMismatch(f"Opening {row.pk} does not belong to this row.") from None
    if not (same_row and same_salt and opening.get("kind") == row.kind and opening_matches(opening, row.commitment)):
        raise OpeningMismatch(f"Opening {row.pk} does not belong to this row.")
    return opening


def check_opening(row):
    """MATCH, MISMATCH or UNAVAILABLE: does this row decrypt, re-hash to its
    commitment, and appear in the payload its anchor recorded? Never raises."""
    try:
        decrypt_opening(row)
    except OpeningUnavailable:
        return UNAVAILABLE
    except OpeningMismatch:
        return MISMATCH
    payload = row.anchor.payload if isinstance(row.anchor.payload, dict) else {}
    expected_kind, field = _ANCHORED_IN.get(row.kind, (None, None))
    if expected_kind is None or payload.get("kind") != expected_kind:
        return MISMATCH
    if hash_payload(payload) != row.anchor.data_hash:
        return MISMATCH
    held = payload.get(field)
    return MATCH if row.commitment == held or (isinstance(held, list) and row.commitment in held) else MISMATCH


# ── Access ───────────────────────────────────────────────────────────────────

def may_read_opening(user, row):
    """Admin and Head: every opening. A supplier: the leaf of their own bid, or
    their own award's openings. The public: none. Nothing else."""
    if not (user and user.is_authenticated and user.is_active):
        return False
    role = getattr(user, "role", None)
    if role in {"admin", "head"}:
        return True
    if role != "supplier" or row.supplier_id is None:
        return False
    return Supplier.objects.filter(pk=row.supplier_id, user=user).exists()


def read_opening(request, user, row):
    """Hand one opening to `user`, and audit it. The one way a person gets an
    opening: nothing else may return decrypt_opening()'s result to a caller."""
    if not may_read_opening(user, row):
        log_action(request, "commitment.open_denied", user=user if getattr(user, "is_authenticated", False) else None,
                   entity_type="BlockchainAnchor", entity_id=row.anchor_id,
                   description=f"Refused {row.kind} opening {row.pk} of anchor {row.anchor_id}.")
        raise OpeningAccessDenied(f"Opening {row.pk} is not available to this user.")
    opening = decrypt_opening(row)
    log_action(request, "commitment.opened", user=user, entity_type="BlockchainAnchor", entity_id=row.anchor_id,
               description=f"Opened {row.kind} opening {row.pk} of anchor {row.anchor_id}.")
    return opening


# ── Rotation ─────────────────────────────────────────────────────────────────

def rotate_opening(row, *, apply):
    """Re-encrypt `row` under the current key. Returns "current", "rotated" or
    "unavailable". Only the ciphertext changes, and only after the new token has
    been decrypted and compared with the old one's plaintext."""
    from cryptography.fernet import Fernet, InvalidToken

    token = row.ciphertext.encode("ascii")
    try:
        Fernet(_current_key().encode()).decrypt(token)
        return "current"
    except InvalidToken:
        pass
    ring = _keyring()
    try:
        plaintext = ring.decrypt(token)
    except InvalidToken:
        return "unavailable"
    if apply:
        new_token = ring.rotate(token)
        if Fernet(_current_key().encode()).decrypt(new_token) != plaintext:
            raise OpeningMismatch(f"Opening {row.pk} did not survive re-encryption.")
        if not CommitmentOpening.rewrap(row.pk, row.ciphertext, new_token.decode("ascii"),
                                        key_fingerprint(_current_key())):
            raise OpeningMismatch(f"Opening {row.pk} changed during rotation.")
    return "rotated"
