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
