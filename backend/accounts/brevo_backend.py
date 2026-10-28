"""Django email backend that sends through Brevo's HTTP API.

Why not SMTP: Render's free web services block outbound SMTP ports (25, 465,
587), so Gmail SMTP works locally but every email silently fails in
production. Brevo's transactional API is plain HTTPS (port 443), which is
allowed. Every send_mail() call in the project (email verification, password
reset, notifications) goes through settings.EMAIL_BACKEND, so they all switch
over without code changes.

Enabled by setting BREVO_API_KEY (see config/settings.py). DEFAULT_FROM_EMAIL
must be a sender address verified in the Brevo dashboard, or Brevo rejects
the message.

Uses urllib from the standard library on purpose: no new dependency.
"""

import json
import logging
import urllib.error
import urllib.request
from email.utils import parseaddr

from django.conf import settings
from django.core.mail.backends.base import BaseEmailBackend

logger = logging.getLogger(__name__)

API_URL = "https://api.brevo.com/v3/smtp/email"


class BrevoAPIError(Exception):
    """Brevo refused or could not take the message. Never includes the API key."""


def _address(value):
    name, email = parseaddr(value)
    out = {"email": email}
    if name:
        out["name"] = name
    return out


class BrevoEmailBackend(BaseEmailBackend):
    def __init__(self, api_key=None, timeout=None, fail_silently=False, **kwargs):
        super().__init__(fail_silently=fail_silently, **kwargs)
        self.api_key = api_key or getattr(settings, "BREVO_API_KEY", "")
        self.timeout = timeout or getattr(settings, "EMAIL_TIMEOUT", 15)

    def send_messages(self, email_messages):
        sent = 0
        for message in email_messages or []:
            try:
                self._send(message)
                sent += 1
            except Exception:
                if not self.fail_silently:
                    raise
        return sent

    def _payload(self, message):
        payload = {
            "sender": _address(message.from_email or settings.DEFAULT_FROM_EMAIL),
            "to": [_address(a) for a in message.to],
            "subject": message.subject,
            "textContent": message.body,
        }
        if message.cc:
            payload["cc"] = [_address(a) for a in message.cc]
        if message.bcc:
            payload["bcc"] = [_address(a) for a in message.bcc]
        if message.reply_to:
            payload["replyTo"] = _address(message.reply_to[0])
        # EmailMultiAlternatives: forward an HTML version when one was attached.
        for content, mimetype in getattr(message, "alternatives", None) or []:
            if mimetype == "text/html":
                payload["htmlContent"] = content
                break
        return payload

    def _send(self, message):
        if not message.recipients():
            return
        if not self.api_key:
            raise BrevoAPIError("BREVO_API_KEY is not set.")
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(self._payload(message)).encode("utf-8"),
            headers={
                "api-key": self.api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            # Brevo explains the problem in the body, e.g. an unverified sender.
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise BrevoAPIError(f"Brevo rejected the email (HTTP {exc.code}): {detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise BrevoAPIError(f"Could not reach Brevo: {exc}") from None
