#!/usr/bin/env python3
"""Run the bounded dialogue-profile backfill against pinned kanouk EmDash."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

from run_emdash_kanouk import EXPECTED_EMAIL, EXPECTED_URL, EmDashGuardError, preflight
from run_wordpress_import_kanouk import CREDENTIAL_FILE, field


WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"
BACKFILL_SCRIPT = WEB_ROOT / "scripts/wordpress/backfill-dialogue-profiles.mjs"


def main() -> int:
    try:
        text = CREDENTIAL_FILE.read_text()
        email = field(text, "Admin Email")
        url = field(text, "URL")
        scopes = field(text, "Scopes")
        status = field(text, "Status")
        token = field(text, "Token")
        if email != EXPECTED_EMAIL or url != EXPECTED_URL:
            raise EmDashGuardError("Credential does not match pinned owner/origin")
        if scopes != "admin" or status != "active" or not token.startswith("ec_pat_"):
            raise EmDashGuardError("Credential is not an active admin token")
        env = dict(os.environ)
        env["EMDASH_URL"] = EXPECTED_URL
        env["EMDASH_TOKEN"] = token
        preflight(env)
        print(
            "EmDash dialogue guard passed: admin token / pinned staging / "
            f"credential owner {EXPECTED_EMAIL}"
        )
        return subprocess.run(
            ["node", str(BACKFILL_SCRIPT), *sys.argv[1:]],
            cwd=WEB_ROOT,
            env=env,
            check=False,
        ).returncode
    except (FileNotFoundError, EmDashGuardError) as exc:
        print(f"Dialogue backfill guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
