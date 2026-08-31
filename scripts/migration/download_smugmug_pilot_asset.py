#!/usr/bin/env python3
"""Download and hash one manifest asset without persisting its signed source URL."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, BinaryIO
from urllib.request import Request, urlopen

SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from audit_smugmug import SmugMugClient, now_iso
from build_smugmug_pilot_manifest import assert_sanitized


def copy_and_hash(source: BinaryIO, destination: BinaryIO) -> dict[str, Any]:
    md5 = hashlib.md5()
    sha256 = hashlib.sha256()
    size = 0
    while chunk := source.read(1024 * 1024):
        destination.write(chunk)
        md5.update(chunk)
        sha256.update(chunk)
        size += len(chunk)
    return {"bytes": size, "md5": md5.hexdigest(), "sha256": sha256.hexdigest()}


def original_exif_summary(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "exiftool",
            "-j",
            "-DateTimeOriginal",
            "-OffsetTimeOriginal",
            "-GPSLatitude",
            "-GPSLongitude",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return {"captured_at": None, "offset": None, "gps_present": None}
    rows = json.loads(result.stdout)
    row = rows[0] if rows else {}
    raw_datetime = row.get("DateTimeOriginal")
    offset = row.get("OffsetTimeOriginal")
    captured_at = None
    if isinstance(raw_datetime, str):
        match = re.fullmatch(r"(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})", raw_datetime)
        if match:
            captured_at = f"{match.group(1)}-{match.group(2)}-{match.group(3)}T{match.group(4)}"
            if isinstance(offset, str) and re.fullmatch(r"[+-]\d{2}:\d{2}", offset):
                captured_at += offset
    return {
        "captured_at": captured_at,
        "offset": offset if isinstance(offset, str) else None,
        "gps_present": bool(row.get("GPSLatitude") and row.get("GPSLongitude")),
    }


def find_live_image(
    client: SmugMugClient, user: str, album_key: str, image_key: str
) -> dict[str, Any]:
    album = None
    for candidate in client.paged(f"/api/v2/user/{user}!albums", "Album"):
        if str(candidate.get("AlbumKey")) == album_key:
            album = candidate
            break
    if album is None:
        raise SystemExit(f"Public album not found: {album_key}")
    images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
    if not images_uri:
        raise SystemExit("Album has no public AlbumImages URI")
    for image in client.paged(images_uri, "AlbumImage"):
        if str(image.get("ImageKey")) == image_key:
            return image
    raise SystemExit(f"Public album asset not found: {image_key}")


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
    result.add_argument("--output", required=True)
    result.add_argument("--receipt", required=True)
    result.add_argument("--api-key-env", default="SMUGMUG_API_KEY")
    return result


def main() -> None:
    args = parser().parse_args()
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    manifest = json.loads(Path(args.manifest).read_text())
    try:
        asset = next(item for item in manifest["assets"] if item["id"] == args.asset_id)
    except StopIteration as exc:
        raise SystemExit(f"Asset is absent from manifest: {args.asset_id}") from exc
    album_source = manifest["album"]["source"]
    source = asset["source"]
    live = find_live_image(
        SmugMugClient(api_key),
        str(album_source["user"]),
        str(album_source["album_key"]),
        str(source["image_key"]),
    )
    archived_uri = live.get("ArchivedUri")
    if not isinstance(archived_uri, str) or not archived_uri:
        raise SystemExit("Asset has no public ArchivedUri")
    expected_md5 = str(source.get("archived_md5") or "").lower()
    live_md5 = str(live.get("ArchivedMD5") or "").lower()
    if not expected_md5 or live_md5 != expected_md5:
        raise SystemExit("Live ArchivedMD5 does not match the frozen manifest")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as handle:
        temporary = Path(handle.name)
        request = Request(
            archived_uri,
            headers={"User-Agent": "kanouk-migration-pilot/1.0"},
        )
        with urlopen(request, timeout=180) as response:
            hashes = copy_and_hash(response, handle)
    if hashes["md5"] != expected_md5:
        temporary.unlink(missing_ok=True)
        raise SystemExit("Downloaded bytes do not match SmugMug ArchivedMD5")
    temporary.replace(output)

    exif_summary = original_exif_summary(output)

    receipt = {
        "receipt_version": 1,
        "verified_at": now_iso(),
        "asset_id": asset["id"],
        "filename": source["filename"],
        "bytes": hashes["bytes"],
        "md5": hashes["md5"],
        "sha256": hashes["sha256"],
        "source_md5_verified": True,
        "source_exif": exif_summary,
        "signed_download_uri_persisted": False,
    }
    assert_sanitized(receipt)
    write_json_atomic(Path(args.receipt), receipt)
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == "__main__":
    main()
