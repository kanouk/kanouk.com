#!/usr/bin/env python3
"""Verify a kanouk Cloudflare backup and rehearse its D1 restore locally."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile


def file_hash(path: Path, algorithm: str) -> tuple[str, int]:
    digest = hashlib.new(algorithm)
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.backup / "manifest.json").read_text())
    d1_path = args.backup / manifest["d1"]["relative_path"]
    d1_hash, d1_size = file_hash(d1_path, "sha256")
    if d1_hash != manifest["d1"]["sha256"] or d1_size != manifest["d1"]["bytes"]:
        raise SystemExit("D1 export checksum mismatch")
    verified_bytes = 0
    for item in manifest["media"]:
        path = args.backup / item["relative_path"]
        sha256, size = file_hash(path, "sha256")
        if sha256 != item["sha256"] or size != item["bytes"]:
            raise SystemExit(f"Media checksum mismatch: {item['storage_key']}")
        verified_bytes += size
    if verified_bytes != manifest["media_total_bytes"]:
        raise SystemExit("Media byte total mismatch")
    with tempfile.TemporaryDirectory(prefix="kanouk-d1-restore-") as directory:
        database = Path(directory) / "restore.sqlite3"
        connection = sqlite3.connect(database)
        connection.executescript(d1_path.read_text())
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        table_count = connection.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
        ).fetchone()[0]
        restored_counts = {
            table: connection.execute(
                f'SELECT COUNT(*) FROM "{table.replace(chr(34), chr(34) * 2)}"'
            ).fetchone()[0]
            for table in manifest["d1"].get("row_counts", {})
        }
        connection.close()
    if integrity != "ok":
        raise SystemExit(f"Local D1 restore integrity failed: {integrity}")
    if restored_counts != manifest["d1"].get("row_counts", {}):
        raise SystemExit("Local D1 restore row counts differ from the backup manifest")
    print(
        json.dumps(
            {
                "verified": True,
                "media_count": len(manifest["media"]),
                "media_total_bytes": verified_bytes,
                "d1_tables_restored": table_count,
                "d1_rows_restored": sum(restored_counts.values()),
                "d1_integrity": integrity,
            }
        )
    )


if __name__ == "__main__":
    main()
