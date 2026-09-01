"""Small OAuth 1.0a signer for SmugMug read-only migration requests."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Iterable, Mapping
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit


def encode(value: object) -> str:
    return quote(str(value), safe="~-._")


def signature_base_url(url: str) -> str:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    include_port = port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    )
    authority = f"{hostname}:{port}" if include_port else hostname
    return urlunsplit((scheme, authority, parsed.path or "/", "", ""))


def normalized_parameters(pairs: Iterable[tuple[str, str]]) -> str:
    encoded = sorted((encode(key), encode(value)) for key, value in pairs)
    return "&".join(f"{key}={value}" for key, value in encoded)


def hmac_sha1_signature(
    method: str,
    url: str,
    parameters: Iterable[tuple[str, str]],
    *,
    consumer_secret: str,
    token_secret: str = "",
) -> str:
    base = "&".join(
        (
            encode(method.upper()),
            encode(signature_base_url(url)),
            encode(normalized_parameters(parameters)),
        )
    )
    key = f"{encode(consumer_secret)}&{encode(token_secret)}"
    digest = hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def authorization_header(
    method: str,
    url: str,
    *,
    consumer_key: str,
    consumer_secret: str,
    token: str | None = None,
    token_secret: str = "",
    oauth_extra: Mapping[str, str] | None = None,
    nonce: str | None = None,
    timestamp: str | None = None,
) -> str:
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": nonce or secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_version": "1.0",
        **dict(oauth_extra or {}),
    }
    if token:
        oauth["oauth_token"] = token
    query_pairs = parse_qsl(urlsplit(url).query, keep_blank_values=True)
    signature = hmac_sha1_signature(
        method,
        url,
        [*query_pairs, *oauth.items()],
        consumer_secret=consumer_secret,
        token_secret=token_secret,
    )
    oauth["oauth_signature"] = signature
    values = ", ".join(
        f'{encode(key)}="{encode(value)}"' for key, value in sorted(oauth.items())
    )
    return f"OAuth {values}"
