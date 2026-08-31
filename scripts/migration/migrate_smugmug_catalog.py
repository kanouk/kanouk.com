#!/usr/bin/env python3
"""Run the resumable SmugMug migration across a generated catalog."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]


def selected_rows(
    catalog: dict[str, Any], *, include: set[str], exclude: set[str]
) -> list[dict[str, Any]]:
    rows = list(catalog.get("albums", []))
    if include:
        rows = [row for row in rows if str(row.get("source_album_key")) in include]
    return [row for row in rows if str(row.get("source_album_key")) not in exclude]


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", required=True)
    result.add_argument("--include-album-key", action="append", default=[])
    result.add_argument("--exclude-album-key", action="append", default=[])
    result.add_argument("--apply", action="store_true")
    result.add_argument("--continue-on-error", action="store_true")
    result.add_argument("--concurrency", type=int, default=1)
    return result


def main() -> None:
    args = parser().parse_args()
    catalog_path = Path(args.catalog).resolve()
    catalog = json.loads(catalog_path.read_text())
    rows = selected_rows(
        catalog,
        include=set(args.include_album_key),
        exclude=set(args.exclude_album_key),
    )
    if args.concurrency < 1 or args.concurrency > 4:
        raise SystemExit("--concurrency must be between 1 and 4")
    summary = {"albums_selected": len(rows), "albums_succeeded": 0, "albums_failed": 0}

    def migrate(index: int, row: dict[str, Any]) -> tuple[int, int]:
        manifest = catalog_path.parent / str(row["manifest"])
        print(
            f"album [{index}/{len(rows)}] {row['slug']} "
            f"({row['asset_count']} assets)",
            flush=True,
        )
        command = [
            sys.executable,
            str(SCRIPT_ROOT / "migrate_smugmug_album.py"),
            "--manifest",
            str(manifest),
        ]
        if args.apply:
            command.append("--apply")
        if args.continue_on_error:
            command.append("--continue-on-error")
        result = subprocess.run(command, cwd=REPO_ROOT, env=os.environ, check=False)
        return index, result.returncode

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {
            executor.submit(migrate, index, row): index
            for index, row in enumerate(rows, 1)
        }
        for future in as_completed(futures):
            _, returncode = future.result()
            if returncode == 0:
                summary["albums_succeeded"] += 1
                continue
            summary["albums_failed"] += 1
            if not args.continue_on_error:
                for pending in futures:
                    pending.cancel()
                raise SystemExit(returncode)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if summary["albums_failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
