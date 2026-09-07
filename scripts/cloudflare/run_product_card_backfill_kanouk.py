#!/usr/bin/env python3
"""Run the bounded product-card repair using the existing scoped EmDash token."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys

from run_emdash_kanouk import (
    EmDashGuardError,
    child_environment,
    load_credential,
    preflight,
)


WEB_ROOT = Path(__file__).resolve().parents[2] / "apps/web"
BACKFILL_SCRIPT = WEB_ROOT / "scripts/wordpress/backfill-product-cards.mjs"


def main() -> int:
    try:
        env = child_environment(load_credential())
        preflight(env)
        return subprocess.run(
            ["node", str(BACKFILL_SCRIPT), *sys.argv[1:]],
            cwd=WEB_ROOT,
            env=env,
            check=False,
        ).returncode
    except EmDashGuardError as exc:
        print(f"Product-card repair guard blocked the command: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
