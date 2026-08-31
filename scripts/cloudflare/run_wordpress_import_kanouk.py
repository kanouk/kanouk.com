#!/usr/bin/env python3
"""Run the WordPress importer against only the pinned kanouk EmDash staging."""

from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys

from run_emdash_kanouk import (
    EXPECTED_EMAIL,
    EXPECTED_URL,
    EmDashGuardError,
    load_credential as load_regular_credential,
    preflight,
)


PRIVATE_VAULT = Path(
    os.environ.get("KANOUK_PRIVATE_VAULT", "/Users/kanouk/Documents/Private")
)
CREDENTIAL_FILE = PRIVATE_VAULT / "10_sensitive/api-keys/EmDash-kanouk-import-admin.md"
WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"
IMPORT_SCRIPT = WEB_ROOT / "scripts/wordpress/import-wxr.mjs"


def field(text: str, label: str) -> str:
    match = re.search(rf"^- {re.escape(label)}: `([^`]+)`$", text, re.MULTILINE)
    if not match or not match.group(1).strip():
        raise EmDashGuardError(f"Credential file is missing {label}")
    return match.group(1).strip()


def main() -> int:
    try:
        text = CREDENTIAL_FILE.read_text()
        email = field(text, "Admin Email")
        url = field(text, "URL")
        scopes = field(text, "Scopes")
        status = field(text, "Status")
        token = field(text, "Token")
        if email != EXPECTED_EMAIL or url != EXPECTED_URL:
            raise EmDashGuardError("Temporary credential does not match pinned owner/origin")
        if scopes != "admin" or status != "active" or not token.startswith("ec_pat_"):
            raise EmDashGuardError("Temporary credential is not an active admin token")
        env = dict(os.environ)
        env["EMDASH_URL"] = EXPECTED_URL
        env["EMDASH_TOKEN"] = token
        preflight(env)
        regular = load_regular_credential()
        env["EMDASH_READ_TOKEN"] = regular["token"]
        print(
            "EmDash import guard passed: temporary admin token / pinned staging / "
            f"credential owner {EXPECTED_EMAIL}"
        )
        return subprocess.run(
            ["node", str(IMPORT_SCRIPT), *sys.argv[1:]],
            cwd=WEB_ROOT,
            env=env,
            check=False,
        ).returncode
    except (FileNotFoundError, EmDashGuardError) as exc:
        print(f"WordPress import guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
