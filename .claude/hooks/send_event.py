#!/usr/bin/env python3
"""
Shared utility: POST hook events to the AiRemoteCoder gateway with HMAC auth.

Reads auth credentials from environment variables that ClaudeRunner injects
into the Claude subprocess:
    AI_GATEWAY_URL          – base URL of the Fastify gateway
    AI_HMAC_SECRET          – shared secret for request signing
    AI_RUN_ID               – current run identifier
    AI_CAPABILITY_TOKEN     – capability token for this run
    AI_ALLOW_SELF_SIGNED    – 'true' to skip TLS verification (dev)

The HMAC signature scheme mirrors wrapper/src/utils/crypto.ts exactly:
    message = METHOD\nPATH\nSHA256(body)\nTIMESTAMP\nNONCE\nRUN_ID\nCAP_TOKEN
    signature = HMAC-SHA256(HMAC_SECRET, message)
"""

import hashlib
import hmac
import json
import os
import ssl
import sys
import time
from urllib.request import Request, urlopen


def _sha256_hex(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _sign(secret: str, method: str, path: str, body_hash: str,
          timestamp: int, nonce: str, run_id: str, cap_token: str) -> str:
    message = "\n".join([
        method.upper(),
        path,
        body_hash,
        str(timestamp),
        nonce,
        run_id,
        cap_token,
    ])
    return hmac.new(
        secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def send(event_type: str, data: str) -> bool:
    """POST a single event to /api/ingest/event.  Returns True on success.

    Fails silently when credentials are missing – the hook must never block
    Claude Code execution.
    """
    gateway_url = os.environ.get("AI_GATEWAY_URL", "").rstrip("/")
    hmac_secret = os.environ.get("AI_HMAC_SECRET", "")
    run_id = os.environ.get("AI_RUN_ID", "")
    cap_token = os.environ.get("AI_CAPABILITY_TOKEN", "")

    if not all([gateway_url, hmac_secret, run_id, cap_token]):
        return False

    path = "/api/ingest/event"
    payload = json.dumps({"type": event_type, "data": data})
    body_bytes = payload.encode("utf-8")

    timestamp = int(time.time())
    nonce = os.urandom(16).hex()
    body_hash = _sha256_hex(payload)
    signature = _sign(hmac_secret, "POST", path, body_hash,
                      timestamp, nonce, run_id, cap_token)

    url = f"{gateway_url}{path}"
    req = Request(url, data=body_bytes, headers={
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Timestamp": str(timestamp),
        "X-Nonce": nonce,
        "X-Run-Id": run_id,
        "X-Capability-Token": cap_token,
    })

    ctx = ssl.create_default_context()
    if os.environ.get("AI_ALLOW_SELF_SIGNED", "").lower() == "true":
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    try:
        urlopen(req, timeout=5, context=ctx)
        return True
    except Exception:
        return False


# Convenience: can be invoked directly as  python send_event.py <type> <data>
if __name__ == "__main__":
    if len(sys.argv) >= 3:
        success = send(sys.argv[1], sys.argv[2])
        sys.exit(0 if success else 1)
