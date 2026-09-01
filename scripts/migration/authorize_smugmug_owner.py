#!/usr/bin/env python3
"""Authorize read-only owner access and store the long-lived token privately."""

from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import parse_qs, urlencode
from urllib.request import Request, urlopen

from smugmug_oauth import authorization_header


DEFAULT_CREDENTIAL_FILE = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
) / "10_sensitive/api-keys/SmugMug.md"
REQUEST_TOKEN_URL = "https://api.smugmug.com/services/oauth/1.0a/getRequestToken"
AUTHORIZE_URL = "https://api.smugmug.com/services/oauth/1.0a/authorize"
ACCESS_TOKEN_URL = "https://api.smugmug.com/services/oauth/1.0a/getAccessToken"


def secret_value(text: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}:\s*`([^`]+)`$", text, re.MULTILINE)
    if not match or not match.group(1).strip():
        raise RuntimeError(f"Credential file has no configured {label}")
    return match.group(1).strip()


def oauth_token_request(
    url: str,
    *,
    consumer_key: str,
    consumer_secret: str,
    token: str | None = None,
    token_secret: str = "",
    oauth_extra: dict[str, str] | None = None,
) -> tuple[str, str]:
    header = authorization_header(
        "POST",
        url,
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=token,
        token_secret=token_secret,
        oauth_extra=oauth_extra,
    )
    request = Request(
        url,
        data=b"",
        method="POST",
        headers={"Authorization": header, "User-Agent": "kanouk-migration/1.0"},
    )
    with urlopen(request, timeout=60) as response:
        payload = parse_qs(response.read().decode(), keep_blank_values=True)
    access_token = (payload.get("oauth_token") or [""])[0]
    access_secret = (payload.get("oauth_token_secret") or [""])[0]
    if not access_token or not access_secret:
        raise RuntimeError("SmugMug OAuth response omitted token credentials")
    return access_token, access_secret


def store_access_token(path: Path, token: str, token_secret: str) -> None:
    text = path.read_text()
    additions = {
        "Access Token": token,
        "Access Token Secret": token_secret,
    }
    for label, value in additions.items():
        pattern = rf"^{re.escape(label)}:\s*`[^`]*`$"
        replacement = f"{label}: `{value}`"
        if re.search(pattern, text, re.MULTILINE):
            text = re.sub(pattern, replacement, text, flags=re.MULTILINE)
        else:
            text = text.rstrip() + f"\n{replacement}\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", dir=path.parent, delete=False, prefix=f".{path.name}.", encoding="utf-8"
    ) as output:
        output.write(text)
        temporary = Path(output.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credential-file", type=Path, default=DEFAULT_CREDENTIAL_FILE)
    args = parser.parse_args()
    text = args.credential_file.read_text()
    consumer_key = secret_value(text, "API Key")
    consumer_secret = secret_value(text, "API Secret")
    request_token, request_secret = oauth_token_request(
        REQUEST_TOKEN_URL,
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        oauth_extra={"oauth_callback": "oob"},
    )
    authorization_url = f"{AUTHORIZE_URL}?{urlencode({'oauth_token': request_token, 'Access': 'Full', 'Permissions': 'Read'})}"
    print("SmugMugで読み取り専用アクセスを許可してください:")
    print(authorization_url)
    verifier = getpass.getpass("表示された6桁コード: ").strip()
    if not re.fullmatch(r"\d{6}", verifier):
        raise SystemExit("6桁の確認コードが必要です")
    access_token, access_secret = oauth_token_request(
        ACCESS_TOKEN_URL,
        consumer_key=consumer_key,
        consumer_secret=consumer_secret,
        token=request_token,
        token_secret=request_secret,
        oauth_extra={"oauth_verifier": verifier},
    )
    store_access_token(args.credential_file, access_token, access_secret)
    print(f"Owner read token saved to {args.credential_file} (values hidden)")


if __name__ == "__main__":
    main()
