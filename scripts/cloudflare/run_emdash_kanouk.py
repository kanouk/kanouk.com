#!/usr/bin/env python3
"""Run remote EmDash CLI commands with the kanouk.com migration token only."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping, Sequence


EXPECTED_EMAIL = "kanouk@gmail.com"
EXPECTED_URL = "https://kanouk-emdash-staging.kanouk.workers.dev"
DEFAULT_CREDENTIAL_FILE = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
) / "10_sensitive/api-keys/EmDash-kanouk.md"
WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"
ALLOWED_COMMANDS = {"content", "media", "schema", "types"}


class EmDashGuardError(RuntimeError):
    pass


def _field(text: str, label: str) -> str:
    match = re.search(rf"^- {re.escape(label)}: `([^`]+)`$", text, re.MULTILINE)
    if not match or not match.group(1).strip():
        raise EmDashGuardError(f"Credential file is missing the {label} field")
    return match.group(1).strip()


def load_credential(path: Path = DEFAULT_CREDENTIAL_FILE) -> dict[str, str]:
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        raise EmDashGuardError(f"Credential file does not exist: {path}") from exc
    credential = {
        "email": _field(text, "Admin Email"),
        "url": _field(text, "URL"),
        "token": _field(text, "Token"),
    }
    if credential["email"] != EXPECTED_EMAIL:
        raise EmDashGuardError(f"Admin Email must be {EXPECTED_EMAIL}")
    if credential["url"] != EXPECTED_URL:
        raise EmDashGuardError(f"URL must be {EXPECTED_URL}")
    if not credential["token"].startswith("ec_pat_"):
        raise EmDashGuardError("Token has an unexpected format")
    return credential


def store_token(token: str, path: Path = DEFAULT_CREDENTIAL_FILE) -> None:
    value = token.strip()
    if not value.startswith("ec_pat_") or len(value) < 24:
        raise EmDashGuardError("Token has an unexpected format")
    if path.exists():
        raise EmDashGuardError(f"Credential file already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# EmDash kanouk.com staging\n\n"
        f"- Admin Email: `{EXPECTED_EMAIL}`\n"
        f"- URL: `{EXPECTED_URL}`\n"
        "- Token Name: `kanouk.com migration pilot`\n"
        "- Scopes: `content:read content:write media:read media:write schema:read`\n"
        "- Expires: `30 days from creation`\n"
        f"- Token: `{value}`\n"
    )
    path.chmod(0o600)


def child_environment(
    credential: Mapping[str, str], base: Mapping[str, str] | None = None
) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    env.pop("EMDASH_TOKEN", None)
    env.pop("EMDASH_URL", None)
    env["EMDASH_TOKEN"] = credential["token"]
    env["EMDASH_URL"] = credential["url"]
    return env


def normalized_args(args: Sequence[str]) -> list[str]:
    result = list(args)
    if result[:1] == ["--"]:
        result = result[1:]
    if not result or result[0] not in ALLOWED_COMMANDS:
        raise EmDashGuardError(
            "Command is not allowlisted: " + ", ".join(sorted(ALLOWED_COMMANDS))
        )
    if "--url" in result or "-u" in result:
        raise EmDashGuardError("URL overrides are blocked; the staging origin is pinned")
    return result


def validate_schema_preflight(payload: Mapping[str, Any]) -> None:
    serialized = json.dumps(payload, ensure_ascii=False)
    missing = [slug for slug in ("albums", "photos", "posts") if slug not in serialized]
    if missing:
        raise EmDashGuardError(
            "Pinned staging schema is missing expected collections: " + ", ".join(missing)
        )


def preflight(env: Mapping[str, str]) -> None:
    result = subprocess.run(
        ["bunx", "emdash", "schema", "list", "--url", EXPECTED_URL, "--json"],
        cwd=WEB_ROOT,
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr.strip() or result.stdout.strip()).replace(
            env.get("EMDASH_TOKEN", ""), "[redacted]"
        )
        raise EmDashGuardError(
            f"EmDash authentication preflight failed ({result.returncode}): "
            f"{detail[:300] or 'no diagnostic output'}"
        )
    try:
        validate_schema_preflight(json.loads(result.stdout))
    except json.JSONDecodeError as exc:
        raise EmDashGuardError("EmDash returned an invalid schema response") from exc


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args == ["--store-token-stdin"]:
            store_token(sys.stdin.read())
            print(f"Stored EmDash credential for {EXPECTED_EMAIL} in Private Vault")
            return 0
        credential = load_credential()
        env = child_environment(credential)
        preflight(env)
        command = normalized_args(args)
        print(
            "EmDash guard passed: scoped token / pinned staging / "
            f"credential owner {EXPECTED_EMAIL}"
        )
        return subprocess.run(
            ["bunx", "emdash", *command, "--url", EXPECTED_URL],
            cwd=WEB_ROOT,
            env=env,
            check=False,
        ).returncode
    except EmDashGuardError as exc:
        print(f"EmDash guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
