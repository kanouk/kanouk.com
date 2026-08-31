#!/usr/bin/env python3
"""Record a public EmDash media file while preserving source GPS metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from typing import Any

from audit_smugmug import now_iso


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def metadata(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "exiftool",
            "-n",
            "-j",
            "-GPSLatitude",
            "-GPSLongitude",
            "-ProfileDescription",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError("Could not inspect public media metadata")
    rows = json.loads(result.stdout)
    row = rows[0] if rows else {}
    return {
        "latitude": row.get("GPSLatitude"),
        "longitude": row.get("GPSLongitude"),
        "icc_profile": row.get("ProfileDescription"),
    }


def valid_coordinate(value: Any, minimum: float, maximum: float) -> bool:
    return isinstance(value, (int, float)) and minimum <= float(value) <= maximum


def gps_present(value: dict[str, Any]) -> bool:
    return valid_coordinate(value.get("latitude"), -90, 90) and valid_coordinate(
        value.get("longitude"), -180, 180
    )


def gps_matches(source: dict[str, Any], public: dict[str, Any]) -> bool:
    if not gps_present(source):
        return not gps_present(public)
    if not gps_present(public):
        return False
    return abs(float(source["latitude"]) - float(public["latitude"])) <= 0.000001 and abs(
        float(source["longitude"]) - float(public["longitude"])
    ) <= 0.000001


def record(
    manifest: dict[str, Any],
    *,
    asset_id: str,
    emdash_album_content_id: str,
    emdash_photo_content_id: str,
    emdash_media_id: str,
    storage_key: str,
    derivative_sha256: str,
    derivative_bytes: int,
    source_metadata: dict[str, Any],
    public_metadata: dict[str, Any],
) -> dict[str, Any]:
    if not gps_matches(source_metadata, public_metadata):
        raise ValueError("Public media does not preserve the source GPS metadata")
    try:
        asset = next(item for item in manifest["assets"] if item["id"] == asset_id)
    except StopIteration as exc:
        raise ValueError(f"Asset is absent from manifest: {asset_id}") from exc
    manifest["album"].setdefault("destination", {})[
        "emdash_content_id"
    ] = emdash_album_content_id
    asset["destination"]["emdash_content_id"] = emdash_photo_content_id
    asset["destination"]["emdash_media_id"] = emdash_media_id
    asset["destination"]["r2_object_key"] = storage_key
    asset["verification"].pop("public_derivative", None)
    asset["verification"]["public_asset"] = {
        "sha256": derivative_sha256,
        "bytes": derivative_bytes,
        "gps_present": gps_present(public_metadata),
        "gps_preserved": True,
        "icc_profile": public_metadata.get("icc_profile"),
        "metadata_policy": "Source GPS EXIF retained; coordinates stored outside Git",
        "recorded_at": now_iso(),
    }
    return asset


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--manifest", required=True)
    result.add_argument("--asset-id", required=True)
    result.add_argument("--emdash-album-content-id", required=True)
    result.add_argument("--emdash-photo-content-id", required=True)
    result.add_argument("--emdash-media-id", required=True)
    result.add_argument("--storage-key", required=True)
    result.add_argument("--source-file", required=True)
    result.add_argument("--file", required=True)
    return result


def main() -> None:
    args = parser().parse_args()
    manifest_path = Path(args.manifest)
    derivative_path = Path(args.file)
    manifest = json.loads(manifest_path.read_text())
    asset = record(
        manifest,
        asset_id=args.asset_id,
        emdash_album_content_id=args.emdash_album_content_id,
        emdash_photo_content_id=args.emdash_photo_content_id,
        emdash_media_id=args.emdash_media_id,
        storage_key=args.storage_key,
        derivative_sha256=sha256_file(derivative_path),
        derivative_bytes=derivative_path.stat().st_size,
        source_metadata=metadata(Path(args.source_file)),
        public_metadata=metadata(derivative_path),
    )
    write_json_atomic(manifest_path, manifest)
    print(
        json.dumps(
            {
                "asset_id": asset["id"],
                "emdash_album_content_id": manifest["album"]["destination"]["emdash_content_id"],
                "emdash_photo_content_id": asset["destination"]["emdash_content_id"],
                "emdash_media_id": asset["destination"]["emdash_media_id"],
                "r2_object_key": asset["destination"]["r2_object_key"],
                "public_asset": asset["verification"]["public_asset"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
