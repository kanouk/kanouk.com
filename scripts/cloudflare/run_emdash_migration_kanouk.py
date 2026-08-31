#!/usr/bin/env python3
"""Run EmDash D1 migrations only after validating the kanouk Cloudflare account."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys
from typing import Sequence

from run_wrangler_kanouk import (
    GuardError,
    child_environment,
    load_credential,
    masked_account_id,
    preflight,
)


WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["--"]:
        args = args[1:]
    if not args:
        print(
            "Specify EmDash migrate arguments such as --status or "
            "--expected-target-fingerprint <fingerprint>",
            file=sys.stderr,
        )
        return 2

    try:
        credential = load_credential()
        env = child_environment(credential)
        preflight(credential, env)
        print(
            "Cloudflare guard passed for EmDash migration: "
            f"{credential['email']} / account "
            f"{masked_account_id(credential['account_id'])}"
        )
        return subprocess.run(
            ["bunx", "emdash", "migrate", *args],
            cwd=WEB_ROOT,
            env=env,
            check=False,
        ).returncode
    except GuardError as exc:
        print(f"EmDash migration guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
