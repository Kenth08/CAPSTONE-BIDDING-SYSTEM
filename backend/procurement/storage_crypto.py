"""Application-level encryption of supplier registration documents.

WHAT IS ENCRYPTED, AND WHY ONLY THAT
------------------------------------
Supplier registration documents (government IDs, tax clearances, audited
financial statements, bank letters, permits, category licenses) are the most
sensitive files in the system and are never anchored on-chain. They are
encrypted with Fernet (AES-128-CBC + HMAC-SHA256) before they reach storage, so
a leaked bucket key or a mis-set bucket policy exposes only ciphertext.

Bid, project and award documents are NOT encrypted here. Their SHA-256 is
anchored on Sepolia and re-checked by the public verifier's deep check, so they
must stay byte-for-byte what was hashed; they rely on the private bucket plus
the storage provider's own encryption at rest (Supabase Storage encrypts all
objects with AES-256).

FORMAT AND COMPATIBILITY
------------------------
An encrypted file is MAGIC + a Fernet token. Anything without MAGIC is served
as-is, so every file stored before encryption was switched on still opens.

KEYS
----
FILE_ENCRYPTION_KEY       the current key (used to encrypt; also decrypts)
FILE_ENCRYPTION_OLD_KEYS  comma-separated retired keys (decrypt only)

Generate a key with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Rotation, without downtime:
  1. Put the current key in FILE_ENCRYPTION_OLD_KEYS and a new key in
     FILE_ENCRYPTION_KEY; deploy. New uploads use the new key, old files still
     decrypt with the old one.
  2. Run `python manage.py encrypt_supplier_documents --apply` to re-encrypt
     every stored document under the new key.
  3. Only then remove the old key from FILE_ENCRYPTION_OLD_KEYS.
Losing every key that a file was encrypted with makes that file unreadable —
store the keys in a password manager as well as in Render.
"""
import io
import logging

from django.conf import settings
from django.core.files.base import ContentFile, File

logger = logging.getLogger(__name__)

MAGIC = b"PCENC1\n"


class EncryptionNotConfigured(Exception):
    """Raised when decrypting a file but no key is configured."""


def _keys():
    current = (getattr(settings, "FILE_ENCRYPTION_KEY", "") or "").strip()
    old = [k.strip() for k in (getattr(settings, "FILE_ENCRYPTION_OLD_KEYS", "") or "").split(",")
           if k.strip()]
    return current, old


def encryption_enabled():
    return bool(_keys()[0])


def _multifernet():
    from cryptography.fernet import Fernet, MultiFernet

    current, old = _keys()
    keys = ([current] if current else []) + old
    if not keys:
        raise EncryptionNotConfigured("FILE_ENCRYPTION_KEY is not set.")
    return MultiFernet([Fernet(k.encode()) for k in keys])


def is_encrypted(data):
    return data[: len(MAGIC)] == MAGIC


def encrypt_bytes(data):
    """MAGIC + Fernet token for `data` under the current key."""
    return MAGIC + _multifernet().encrypt(data)


def decrypt_bytes(data):
    """Plaintext of `data`; data without MAGIC (legacy, unencrypted) is
    returned unchanged."""
    if not is_encrypted(data):
        return data
    return _multifernet().decrypt(data[len(MAGIC):])


def reencrypt_bytes(data):
    """`data` encrypted under the CURRENT key: plaintext is encrypted, a file
    under a retired key is rotated. Returns None when nothing would change."""
    from cryptography.fernet import Fernet, InvalidToken

    if not is_encrypted(data):
        return encrypt_bytes(data)
    token = data[len(MAGIC):]
    try:
        Fernet(_keys()[0].encode()).decrypt(token)
        return None                      # already under the current key
    except InvalidToken:
        return MAGIC + _multifernet().rotate(token)


def encrypt_upload(field_file):
    """Replace a not-yet-stored upload's content with its encrypted form.
    No-op when no key is configured (logged once at startup instead)."""
    if not encryption_enabled():
        return
    f = field_file.file
    f.seek(0)
    data = f.read()
    if is_encrypted(data):
        return
    field_file.file = ContentFile(encrypt_bytes(data), name=field_file.name)


def open_for_download(field_file):
    """An open, readable binary handle for `field_file`'s PLAINTEXT bytes —
    decrypted when the stored file is encrypted, untouched otherwise."""
    handle = field_file.open("rb")
    head = handle.read(len(MAGIC))
    if head != MAGIC:
        handle.seek(0)
        return handle
    data = head + handle.read()
    handle.close()
    return File(io.BytesIO(decrypt_bytes(data)), name=field_file.name)
