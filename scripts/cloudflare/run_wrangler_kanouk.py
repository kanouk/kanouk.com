#!/usr/bin/env python3
"""Run Wrangler only with the kanouk.com Cloudflare credential.

The credential is loaded from the Private Vault, injected only into child
processes, and never printed. Every invocation validates Wrangler's account
response before running the requested command.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Mapping, Sequence


EXPECTED_EMAIL = "kanouk@gmail.com"
WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"
WRANGLER_BIN = WEB_ROOT / "node_modules/.bin/wrangler"
DEFAULT_CREDENTIAL_FILE = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
) / "10_sensitive/api-keys/Cloudflare-kanouk.md"
PLACEHOLDER_PREFIX = "REPLACE_WITH_"
BLOCKED_COMMANDS = {"login", "logout"}


class GuardError(RuntimeError):
    pass


def _field(text: str, label: str) -> str:
    match = re.search(rf"^- {re.escape(label)}: `([^`]+)`$", text, re.MULTILINE)
    if not match:
        raise GuardError(f"Credential file is missing the {label} field")
    value = match.group(1).strip()
    if not value or value.startswith(PLACEHOLDER_PREFIX):
        raise GuardError(f"Credential file has no configured {label}")
    return value


def load_credential(path: Path = DEFAULT_CREDENTIAL_FILE) -> dict[str, str]:
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        raise GuardError(f"Credential file does not exist: {path}") from exc
    email = _field(text, "Email")
    if email != EXPECTED_EMAIL:
        raise GuardError(
            f"Credential email must be {EXPECTED_EMAIL}; refusing to run Wrangler"
        )
    return {
        "email": email,
        "account_id": _field(text, "Account ID"),
        "api_token": _field(text, "Token"),
    }


def child_environment(
    credential: Mapping[str, str], base: Mapping[str, str] | None = None
) -> dict[str, str]:
    env = dict(base if base is not None else os.environ)
    for key in (
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
    ):
        env.pop(key, None)
    env["CLOUDFLARE_API_TOKEN"] = credential["api_token"]
    env["CLOUDFLARE_ACCOUNT_ID"] = credential["account_id"]
    return env


def validate_whoami(payload: Mapping[str, Any], credential: Mapping[str, str]) -> None:
    if not payload.get("loggedIn"):
        raise GuardError("Wrangler did not authenticate with the configured API token")

    email = payload.get("email")
    if email and email != credential["email"]:
        raise GuardError(
            f"Wrangler authenticated as {email}, not {credential['email']}; refusing to continue"
        )

    accounts = payload.get("accounts")
    if not isinstance(accounts, list):
        raise GuardError("Wrangler returned no account list")
    account_ids = {
        account.get("id") for account in accounts if isinstance(account, dict)
    }
    expected_id = credential["account_id"]
    if account_ids != {expected_id}:
        raise GuardError(
            "API token is not restricted to the expected kanouk.com account; "
            "refusing to continue"
        )


def preflight(credential: Mapping[str, str], env: Mapping[str, str]) -> None:
    result = subprocess.run(
        [str(WRANGLER_BIN), "whoami", "--json"],
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise GuardError("Wrangler authentication preflight failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GuardError("Wrangler returned an invalid authentication response") from exc
    validate_whoami(payload, credential)


def normalized_wrangler_args(args: Sequence[str]) -> list[str]:
    result = list(args)
    if result[:1] == ["--"]:
        result = result[1:]
    if not result:
        raise GuardError("Specify a Wrangler command, or use --preflight-only")
    if result[0] in BLOCKED_COMMANDS:
        raise GuardError(
            f"wrangler {result[0]} would alter global authentication and is blocked"
        )
    return result


def masked_account_id(account_id: str) -> str:
    return f"…{account_id[-6:]}" if len(account_id) > 6 else "[configured]"


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        credential = load_credential()
        env = child_environment(credential)
        preflight(credential, env)
        print(
            "Cloudflare guard passed: "
            f"{credential['email']} / account {masked_account_id(credential['account_id'])}"
        )
        if args == ["--preflight-only"]:
            return 0
        wrangler_args = normalized_wrangler_args(args)
        return subprocess.run(
            [str(WRANGLER_BIN), *wrangler_args],
            env=env,
            check=False,
        ).returncode
    except GuardError as exc:
        print(f"Cloudflare guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
