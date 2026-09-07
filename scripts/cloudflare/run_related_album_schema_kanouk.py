#!/usr/bin/env python3
"""Apply the bounded related-album field helper to pinned kanouk EmDash only."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
from typing import Sequence


CLOUDFLARE_SCRIPTS = Path(__file__).resolve().parent
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

from run_emdash_kanouk import (  # noqa: E402
    EXPECTED_EMAIL,
    EXPECTED_URL,
    EmDashGuardError,
    child_environment,
    preflight,
)
from run_wordpress_import_kanouk import CREDENTIAL_FILE, field  # noqa: E402


WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"
HELPER_SCRIPT = WEB_ROOT / "scripts/ensure-related-album-field.mjs"


def normalized_args(args: Sequence[str]) -> list[str]:
    values = list(args)
    if values[:1] == ["--"]:
        values = values[1:]
    allowed_flags = {"--dry-run", "--apply"}
    value_flags = {"--backup-manifest", "--receipt"}
    result: list[str] = []
    modes: list[str] = []
    index = 0
    while index < len(values):
        value = values[index]
        if value in {"--origin", "--expected-origin"}:
            raise EmDashGuardError("Origin overrides are blocked; the EmDash worker is pinned")
        if value in allowed_flags:
            modes.append(value)
            result.append(value)
            index += 1
            continue
        if value in value_flags:
            if index + 1 >= len(values) or not values[index + 1]:
                raise EmDashGuardError(f"{value} requires a path")
            result.extend((value, values[index + 1]))
            index += 2
            continue
        raise EmDashGuardError(f"Unsupported related-album schema argument: {value}")
    if len(modes) > 1:
        raise EmDashGuardError("Choose exactly one of --dry-run or --apply")
    mode = modes[0] if modes else "--dry-run"
    if not modes:
        result.insert(0, mode)
    if mode == "--apply":
        for required in value_flags:
            if required not in result:
                raise EmDashGuardError(f"--apply requires {required}")
    elif any(value in result for value in value_flags):
        raise EmDashGuardError("Backup and receipt paths are accepted only with --apply")
    return result


def helper_command(args: Sequence[str]) -> list[str]:
    return [
        "node",
        str(HELPER_SCRIPT),
        *normalized_args(args),
        "--origin",
        EXPECTED_URL,
        "--expected-origin",
        EXPECTED_URL,
    ]


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        text = CREDENTIAL_FILE.read_text()
        credential = {
            "email": field(text, "Admin Email"),
            "url": field(text, "URL"),
            "token": field(text, "Token"),
        }
        scopes = field(text, "Scopes")
        status = field(text, "Status")
        if credential["email"] != EXPECTED_EMAIL or credential["url"] != EXPECTED_URL:
            raise EmDashGuardError("Credential does not match pinned owner/origin")
        if scopes != "admin" or status != "active" or not credential["token"].startswith("ec_pat_"):
            raise EmDashGuardError("Credential is not an active admin token")
        command = helper_command(args)
        env = child_environment(credential, os.environ)
        preflight(env)
        print(
            "EmDash related-album schema guard passed: admin token / pinned worker / "
            f"credential owner {EXPECTED_EMAIL}"
        )
        return subprocess.run(command, cwd=WEB_ROOT, env=env, check=False).returncode
    except (FileNotFoundError, EmDashGuardError) as exc:
        print(f"Related-album schema guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
