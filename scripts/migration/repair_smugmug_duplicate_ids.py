#!/usr/bin/env python3
"""Assign album-scoped IDs to unstarted duplicate SmugMug image occurrences."""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import sys
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from build_smugmug_pilot_manifest import stable_id, write_json_atomic  # noqa: E402


class DuplicateRepairError(RuntimeError):
    pass


def is_verified(asset: dict[str, Any]) -> bool:
    return bool((asset.get("verification") or {}).get("r2_roundtrip_verified"))


def is_started(asset: dict[str, Any]) -> bool:
    destination = asset.get("destination") or {}
    return is_verified(asset) or any(
        destination.get(field)
        for field in ("emdash_content_id", "emdash_media_id", "r2_object_key")
    )


def repair(catalog_path: Path, *, apply: bool) -> dict[str, Any]:
    catalog = json.loads(catalog_path.read_text())
    occurrences: dict[
        str, list[tuple[Path, dict[str, Any], dict[str, Any]]]
    ] = defaultdict(list)
    manifests: dict[Path, dict[str, Any]] = {}
    all_ids: set[str] = set()
    for row in catalog.get("albums", []):
        path = catalog_path.parent / str(row["manifest"])
        manifest = json.loads(path.read_text())
        manifests[path] = manifest
        for asset in manifest.get("assets", []):
            asset_id = str(asset.get("id") or "")
            all_ids.add(asset_id)
            occurrences[asset_id].append((path, manifest, asset))

    changes: list[dict[str, str]] = []
    changed_paths: set[Path] = set()
    for duplicate_id, rows in sorted(occurrences.items()):
        if len(rows) < 2:
            continue
        ordered = sorted(
            rows,
            key=lambda row: (
                not is_verified(row[2]),
                str((row[1].get("album") or {}).get("slug") or ""),
            ),
        )
        for path, manifest, asset in ordered[1:]:
            if is_started(asset):
                raise DuplicateRepairError(
                    f"Cannot change started duplicate asset: {duplicate_id} in {path}"
                )
            album = manifest.get("album") or {}
            album_key = str((album.get("source") or {}).get("album_key") or "")
            image_key = str((asset.get("source") or {}).get("image_key") or "")
            if not album_key or not image_key:
                raise DuplicateRepairError(f"Duplicate asset lacks source identity: {path}")
            replacement = stable_id(
                "kph", "smugmug-album-image", f"{album_key}:{image_key}"
            )
            if replacement in all_ids:
                raise DuplicateRepairError(f"Replacement ID already exists: {replacement}")
            all_ids.add(replacement)
            asset["id"] = replacement
            asset.setdefault("source", {})["stable_id_scope"] = "album-image"
            destination = asset.setdefault("destination", {})
            destination["photo_path"] = f"/p/{replacement}"
            destination["media_path"] = f"/media/{replacement}"
            changes.append(
                {
                    "album": str(album.get("slug") or ""),
                    "previous_id": duplicate_id,
                    "replacement_id": replacement,
                }
            )
            changed_paths.add(path)

    if apply:
        for path in sorted(changed_paths):
            write_json_atomic(path, manifests[path])
    return {"apply": apply, "changes": changes, "changed_manifests": len(changed_paths)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(
        json.dumps(
            repair(Path(args.catalog).resolve(), apply=args.apply),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
