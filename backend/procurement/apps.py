import logging

from django.apps import AppConfig

logger = logging.getLogger("procurement.security")


class ProcurementConfig(AppConfig):
    name = 'procurement'

    def ready(self):
        # Registers the storage-safety system checks, and says loudly at startup
        # (in the Render log) when file storage or encryption is unsafe.
        from . import blockchain
        from .checks import encryption_problems, storage_problems

        blockchain.check_v3_gate(blockchain.PAYLOAD_V3_ENABLED)

        from .openings import commitment_key_fingerprints, commitment_key_problems

        # Fingerprints only. With v3 off nothing uses these keys, so a bad value
        # is reported rather than stopping the release.
        for message in commitment_key_problems(required=False):
            logger.error("COMMITMENT KEY: %s", message)
        for name, fingerprint in commitment_key_fingerprints():
            logger.warning("%s fingerprint: %s", name, fingerprint)

        for cid, message, hint in storage_problems():
            logger.error("UNSAFE FILE STORAGE (%s): %s %s", cid, message, hint)
        for cid, message, hint in encryption_problems():
            logger.warning("%s: %s %s", cid, message, hint)
