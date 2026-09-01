#!/usr/bin/env python3
"""Resume only SmugMug albums that still contain owner-auth-gated assets.

Run this through ``run_smugmug_readonly.py`` so credentials are injected only
into this process. The command is a sanitized preflight unless ``--apply`` is
present, and refuses to write unless all owner OAuth values are available.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Mapping, Sequence


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
OWNER_ENV_NAMES = (
    "SMUGMUG_API_SECRET",
    "SMUGMUG_ACCESS_TOKEN",
    "SMUGMUG_ACCESS_TOKEN_SECRET",
)


def owner_credential_state(environment: Mapping[str, str]) -> str:
    present = [bool(environment.get(name)) for name in OWNER_ENV_NAMES]
    if all(present):
        return "ready"
    if any(present):
        return "incomplete"
    return "missing"


def pending_owner_rows(catalog_path: Path) -> tuple[list[dict[str, Any]], int]:
    catalog = json.loads(catalog_path.read_text())
    rows: list[dict[str, Any]] = []
    pending_assets = 0
    for row in catalog.get("albums", []):
        manifest_path = catalog_path.parent / str(row["manifest"])
        manifest = json.loads(manifest_path.read_text())
        count = sum(
            (asset.get("verification") or {}).get("migration_status")
            == "pending_owner_auth"
            for asset in manifest.get("assets", [])
        )
        if count:
            rows.append(row)
            pending_assets += count
    return rows, pending_assets


def migration_command(
    catalog_path: Path, rows: Sequence[Mapping[str, Any]], *, concurrency: int
) -> list[str]:
    command = [
        sys.executable,
        str(SCRIPT_ROOT / "migrate_smugmug_catalog.py"),
        "--catalog",
        str(catalog_path),
        "--apply",
        "--continue-on-error",
        "--concurrency",
        str(concurrency),
    ]
    for row in rows:
        command.extend(["--include-album-key", str(row["source_album_key"])])
    return command


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", required=True, type=Path)
    result.add_argument("--apply", action="store_true")
    result.add_argument("--concurrency", type=int, default=2)
    return result


def main() -> None:
    args = parser().parse_args()
    if args.concurrency < 1 or args.concurrency > 4:
        raise SystemExit("--concurrency must be between 1 and 4")
    catalog_path = args.catalog.resolve()
    rows, pending_assets = pending_owner_rows(catalog_path)
    credential_state = owner_credential_state(os.environ)
    preflight = {
        "apply": args.apply,
        "owner_credentials": credential_state,
        "albums_selected": len(rows),
        "assets_pending_owner_auth": pending_assets,
        "source_album_keys": [str(row["source_album_key"]) for row in rows],
    }
    print(json.dumps(preflight, ensure_ascii=False), flush=True)

    if not args.apply:
        return
    if credential_state != "ready":
        raise SystemExit(
            "Owner OAuth credentials are not ready; run "
            "scripts/migration/authorize_smugmug_owner.py first"
        )
    if not rows:
        print("No pending_owner_auth assets remain.", flush=True)
        return

    migration = subprocess.run(
        migration_command(catalog_path, rows, concurrency=args.concurrency),
        cwd=REPO_ROOT,
        env=os.environ,
        check=False,
    )
    report = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_ROOT / "report_smugmug_migration.py"),
            "--catalog",
            str(catalog_path),
        ],
        cwd=REPO_ROOT,
        env=os.environ,
        check=False,
    )
    if migration.returncode:
        raise SystemExit(migration.returncode)
    if report.returncode:
        raise SystemExit(report.returncode)


if __name__ == "__main__":
    main()
