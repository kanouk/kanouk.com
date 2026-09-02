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
    parser.add_argument(
        "--output",
        type=Path,
        help="Optionally persist the machine-readable verification receipt.",
    )
    args = parser.parse_args()
    manifest = json.loads((args.backup / "manifest.json").read_text())
    d1_path = args.backup / manifest["d1"]["relative_path"]
    d1_hash, d1_size = file_hash(d1_path, "sha256")
    if d1_hash != manifest["d1"]["sha256"] or d1_size != manifest["d1"]["bytes"]:
        raise SystemExit("D1 export checksum mismatch")
    objects = manifest.get("r2_objects") or manifest["media"]
    verified_by_key: dict[str, int] = {}
    for item in objects:
        storage_key = str(item["storage_key"])
        if storage_key in verified_by_key:
            raise SystemExit(f"Duplicate backup storage key: {storage_key}")
        path = args.backup / item["relative_path"]
        sha256, size = file_hash(path, "sha256")
        if sha256 != item["sha256"] or size != item["bytes"]:
            raise SystemExit(f"Media checksum mismatch: {item['storage_key']}")
        verified_by_key[storage_key] = size
    media_keys = [str(item["storage_key"]) for item in manifest["media"]]
    if len(media_keys) != len(set(media_keys)):
        raise SystemExit("Duplicate EmDash media storage key")
    if len(media_keys) != int(manifest["media_count"]):
        raise SystemExit("EmDash media count mismatch")
    if any(key not in verified_by_key for key in media_keys):
        raise SystemExit("EmDash media is missing from the R2 backup inventory")
    verified_media_bytes = sum(verified_by_key[key] for key in media_keys)
    if verified_media_bytes != manifest["media_total_bytes"]:
        raise SystemExit("Media byte total mismatch")
    verified_r2_bytes = sum(verified_by_key.values())
    expected_r2_bytes = int(
        manifest.get("r2_total_bytes") or manifest["media_total_bytes"]
    )
    if verified_r2_bytes != expected_r2_bytes:
        raise SystemExit("R2 object byte total mismatch")
    if len(objects) != int(manifest.get("r2_object_count") or len(manifest["media"])):
        raise SystemExit("R2 object count mismatch")
    untracked_keys = set(verified_by_key) - set(media_keys)
    verified_untracked_bytes = sum(
        verified_by_key[key] for key in untracked_keys
    )
    if len(untracked_keys) != int(manifest.get("untracked_r2_count") or 0):
        raise SystemExit("Untracked R2 object count mismatch")
    if verified_untracked_bytes != int(
        manifest.get("untracked_r2_total_bytes") or 0
    ):
        raise SystemExit("Untracked R2 object byte total mismatch")
    if manifest.get("untracked_r2") is not None:
        declared_untracked = {
            str(item["storage_key"]) for item in manifest["untracked_r2"]
        }
        if declared_untracked != untracked_keys:
            raise SystemExit("Untracked R2 inventory mismatch")
    with tempfile.TemporaryDirectory(prefix="kanouk-d1-restore-") as directory:
        database = Path(directory) / "restore.sqlite3"
        connection = sqlite3.connect(database)
        connection.executescript(d1_path.read_text())
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
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
    if foreign_key_violations:
        raise SystemExit(
            f"Local D1 restore has {len(foreign_key_violations)} foreign-key violation(s)"
        )
    if restored_counts != manifest["d1"].get("row_counts", {}):
        raise SystemExit("Local D1 restore row counts differ from the backup manifest")
    receipt = {
        "verified": True,
        "media_count": len(manifest["media"]),
        "media_total_bytes": verified_media_bytes,
        "r2_object_count": len(objects),
        "r2_total_bytes": verified_r2_bytes,
        "untracked_r2_count": len(untracked_keys),
        "untracked_r2_total_bytes": verified_untracked_bytes,
        "d1_tables_restored": table_count,
        "d1_rows_restored": sum(restored_counts.values()),
        "d1_integrity": integrity,
        "d1_foreign_key_violations": len(foreign_key_violations),
    }
    output = json.dumps(receipt, indent=2) + "\n"
    if args.output:
        args.output.write_text(output)
    print(output, end="")


if __name__ == "__main__":
    main()
