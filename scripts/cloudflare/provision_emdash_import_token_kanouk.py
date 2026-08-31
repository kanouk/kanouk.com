#!/usr/bin/env python3
"""Provision or revoke one short-lived EmDash import token on kanouk staging.

The regular migration token deliberately has no admin scope. WordPress author
and import administration needs a short-lived admin token, so this helper
creates one only after validating the pinned Cloudflare account and the exact
EmDash owner row. The raw token is written only to the Private Vault.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import uuid

from run_wrangler_kanouk import (
    GuardError,
    child_environment,
    load_credential,
    masked_account_id,
    preflight,
)


EXPECTED_EMAIL = "kanouk@gmail.com"
EXPECTED_DATABASE = "kanouk-content-staging"
EXPECTED_USER_ID = "01M1BV32TF7MJ924AQHAZVFAZ3"
TOKEN_NAME = "kanouk.com WordPress import temporary admin"
PRIVATE_VAULT = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
)
TOKEN_FILE = PRIVATE_VAULT / "10_sensitive/api-keys/EmDash-kanouk-import-admin.md"


class ProvisionError(RuntimeError):
    pass


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _run_sql(command: str, env: dict[str, str]) -> list[dict[str, object]]:
    result = subprocess.run(
        [
            "bunx",
            "wrangler",
            "d1",
            "execute",
            EXPECTED_DATABASE,
            "--remote",
            "--json",
            "--command",
            command,
        ],
        cwd=Path(__file__).resolve().parents[2] / "apps/web",
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ProvisionError("Remote D1 command failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProvisionError("Remote D1 returned invalid JSON") from exc
    if not isinstance(payload, list) or not all(item.get("success") for item in payload):
        raise ProvisionError("Remote D1 did not confirm success")
    return payload


def _rows(payload: list[dict[str, object]], index: int = 0) -> list[dict[str, object]]:
    value = payload[index].get("results", [])
    return value if isinstance(value, list) else []


def _verify_owner(env: dict[str, str]) -> None:
    payload = _run_sql(
        "SELECT id,email,role,disabled FROM users WHERE email="
        + _sql_literal(EXPECTED_EMAIL),
        env,
    )
    rows = _rows(payload)
    if rows != [
        {
            "id": EXPECTED_USER_ID,
            "email": EXPECTED_EMAIL,
            "role": 50,
            "disabled": 0,
        }
    ]:
        raise ProvisionError("Pinned EmDash owner row did not match")


def _generate_token() -> tuple[str, str, str]:
    encoded = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    raw = "ec_pat_" + encoded
    digest = base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest()).decode().rstrip("=")
    return raw, digest, raw[:11]


def _write_credential(raw: str, token_id: str, expires_at: str) -> None:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(
        "# EmDash kanouk.com temporary WordPress import\n\n"
        f"- Admin Email: `{EXPECTED_EMAIL}`\n"
        "- URL: `https://kanouk-emdash-staging.kanouk.workers.dev`\n"
        f"- Token Name: `{TOKEN_NAME}`\n"
        f"- Token ID: `{token_id}`\n"
        "- Scopes: `admin`\n"
        f"- Expires: `{expires_at}`\n"
        f"- Token: `{raw}`\n"
        "- Status: `active`\n"
    )
    TOKEN_FILE.chmod(0o600)


def create(env: dict[str, str]) -> None:
    if TOKEN_FILE.exists():
        text = TOKEN_FILE.read_text()
        if "- Status: `active`" in text:
            raise ProvisionError(f"An active credential already exists: {TOKEN_FILE}")

    _verify_owner(env)
    raw, token_hash, prefix = _generate_token()
    token_id = "wpimport_" + uuid.uuid4().hex
    expires_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(timespec="milliseconds")
    scopes = json.dumps(["admin"], separators=(",", ":"))
    sql = (
        "INSERT INTO _emdash_api_tokens "
        "(id,name,token_hash,prefix,user_id,scopes,expires_at) VALUES ("
        + ",".join(
            _sql_literal(value)
            for value in (
                token_id,
                TOKEN_NAME,
                token_hash,
                prefix,
                EXPECTED_USER_ID,
                scopes,
                expires_at,
            )
        )
        + ")"
    )
    _run_sql(sql, env)
    verification = _run_sql(
        "SELECT id,name,user_id,scopes,expires_at FROM _emdash_api_tokens WHERE id="
        + _sql_literal(token_id),
        env,
    )
    rows = _rows(verification)
    if len(rows) != 1 or rows[0].get("user_id") != EXPECTED_USER_ID:
        raise ProvisionError("Temporary token could not be verified after creation")
    _write_credential(raw, token_id, expires_at)
    print(
        "Created a two-day EmDash import token for "
        f"{EXPECTED_EMAIL}; raw value stored only in {TOKEN_FILE}"
    )


def revoke(env: dict[str, str]) -> None:
    if not TOKEN_FILE.exists():
        raise ProvisionError(f"Credential file does not exist: {TOKEN_FILE}")
    text = TOKEN_FILE.read_text()
    match = re.search(r"^- Token ID: `([^`]+)`$", text, re.MULTILINE)
    if not match or not match.group(1).startswith("wpimport_"):
        raise ProvisionError("Credential file has no expected temporary Token ID")
    token_id = match.group(1)
    _run_sql(
        "DELETE FROM _emdash_api_tokens WHERE id="
        + _sql_literal(token_id)
        + " AND name="
        + _sql_literal(TOKEN_NAME)
        + " AND user_id="
        + _sql_literal(EXPECTED_USER_ID),
        env,
    )
    remaining = _rows(
        _run_sql(
            "SELECT id FROM _emdash_api_tokens WHERE id=" + _sql_literal(token_id),
            env,
        )
    )
    if remaining:
        raise ProvisionError("Temporary token still exists after revoke")
    TOKEN_FILE.write_text(text.replace("- Status: `active`", "- Status: `revoked`"))
    TOKEN_FILE.chmod(0o600)
    print(f"Revoked temporary EmDash import token {token_id}")


def main() -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--create", action="store_true")
    action.add_argument("--revoke", action="store_true")
    args = parser.parse_args()
    try:
        credential = load_credential()
        env = child_environment(credential)
        preflight(credential, env)
        print(
            "Cloudflare guard passed for temporary EmDash token: "
            f"{credential['email']} / account {masked_account_id(credential['account_id'])}"
        )
        if args.create:
            create(env)
        else:
            revoke(env)
        return 0
    except (GuardError, ProvisionError) as exc:
        print(f"Temporary EmDash token operation blocked: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
