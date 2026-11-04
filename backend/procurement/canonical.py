"""The canonical encoding every anchor payload is hashed with — all versions.

Kept apart from blockchain.py so the frozen per-version payload builders
(payload_v2, …) can hash leaves without importing the whole anchoring layer.
blockchain.py re-exports `hash_payload`, so existing imports keep working.

NEVER change this function: every data_hash already on Sepolia was computed
with it, and contracts/payload-hash-vectors.json pins its exact output for both
the backend and the browser verifier.
"""
import hashlib
import json


def hash_payload(payload):
    """Deterministic SHA-256 of a dict, "0x"-prefixed.

    sort_keys makes it independent of insertion order and the compact separators
    remove any whitespace ambiguity, so the frontend / an external auditor can
    reproduce this byte-for-byte from the same JSON."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return "0x" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ── Strict validation (payload v3 onward) ────────────────────────────────────
# hash_payload accepts anything json.dumps can render (`default=str` even turns
# a stray object into text), and it must stay that way for the anchors it has
# already hashed. New payload versions are checked here first, so a value that
# Python and a verifier's browser could encode differently never gets hashed.

# Largest integer JavaScript represents exactly; beyond it the browser verifier
# refuses to hash (receipt.js canonicalJson).
MAX_SAFE_INTEGER = 2 ** 53 - 1


class NonCanonicalPayload(ValueError):
    """A payload holds a value the canonical encoding does not allow."""


def validate_canonical(value, path="payload"):
    """Raise NonCanonicalPayload unless `value` is only objects with ASCII string
    keys, strings and exact integers. No null (absent is ""), no booleans, no
    floats, no arrays: a shape that needs one must be named by its own version."""
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not key.isascii():
                raise NonCanonicalPayload(f"{path}: key {key!r} is not an ASCII string")
            validate_canonical(item, f"{path}.{key}")
    elif type(value) is int:  # noqa: E721 — bool must not pass
        if abs(value) > MAX_SAFE_INTEGER:
            raise NonCanonicalPayload(f"{path}: integer too large to reproduce in a browser")
    elif not isinstance(value, str):
        raise NonCanonicalPayload(f"{path}: {type(value).__name__} values are not allowed")
