#!/usr/bin/env python3
"""Summarize sanitized SmugMug manifests without reading credentials or media."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
from typing import Any


def asset_status(asset: dict[str, Any]) -> str:
    verification = asset.get("verification") or {}
    destination = asset.get("destination") or {}
    if (
        verification.get("r2_roundtrip_verified") is True
        and isinstance(verification.get("sha256"), str)
        and verification.get("sha256")
        and destination.get("emdash_content_id")
        and destination.get("r2_object_key")
    ):
        return "verified"
    status = verification.get("migration_status")
    if status == "pending_owner_auth":
        return status
    if status == "failed":
        return status
    return "pending"


def build_report(catalog_path: Path) -> dict[str, Any]:
    catalog = json.loads(catalog_path.read_text())
    status_counts: Counter[str] = Counter()
    kind_counts: Counter[str] = Counter()
    format_counts: Counter[str] = Counter()
    album_rows: list[dict[str, Any]] = []
    media_ids: set[str] = set()
    duplicate_media_ids: set[str] = set()
    mismatches: list[str] = []

    for row in catalog.get("albums", []):
        manifest_path = catalog_path.parent / str(row["manifest"])
        manifest = json.loads(manifest_path.read_text())
        album = manifest.get("album") or {}
        assets = manifest.get("assets") or []
        expected = int(album.get("asset_count") or 0)
        if expected != len(assets):
            mismatches.append(f"{album.get('slug')}: expected {expected}, found {len(assets)}")
        album_statuses: Counter[str] = Counter()
        for asset in assets:
            status = asset_status(asset)
            status_counts[status] += 1
            album_statuses[status] += 1
            kind_counts[str(asset.get("kind") or "unknown")] += 1
            format_counts[str((asset.get("source") or {}).get("format") or "unknown")] += 1
            media_id = str(asset.get("id") or "")
            if media_id in media_ids:
                duplicate_media_ids.add(media_id)
            media_ids.add(media_id)
        album_rows.append(
            {
                "slug": album.get("slug"),
                "source_album_key": (album.get("source") or {}).get("album_key"),
                "assets": len(assets),
                "statuses": dict(sorted(album_statuses.items())),
                "emdash_content_id_present": bool(
                    (album.get("destination") or {}).get("emdash_content_id")
                ),
            }
        )

    return {
        "report_version": 1,
        "catalog": str(catalog_path),
        "albums": len(album_rows),
        "assets": sum(status_counts.values()),
        "statuses": dict(sorted(status_counts.items())),
        "kinds": dict(sorted(kind_counts.items())),
        "formats": dict(sorted(format_counts.items())),
        "duplicate_media_ids": sorted(duplicate_media_ids),
        "manifest_mismatches": mismatches,
        "complete": (
            status_counts.get("verified", 0) == sum(status_counts.values())
            and not duplicate_media_ids
            and not mismatches
        ),
        "album_results": album_rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    report = json.dumps(
        build_report(Path(args.catalog).resolve()), ensure_ascii=False, indent=2
    ) + "\n"
    if args.output:
        Path(args.output).write_text(report)
    else:
        print(report, end="")


if __name__ == "__main__":
    main()
