#!/usr/bin/env python3
"""Build a sanitized, deterministic manifest for one public SmugMug album."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, Iterable

SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from audit_smugmug import SmugMugClient, now_iso


FORBIDDEN_SOURCE_FIELDS = {
    "ArchivedUri",
    "Latitude",
    "Longitude",
    "Altitude",
    "ThumbnailUrl",
}


def stable_id(prefix: str, source_kind: str, source_id: str) -> str:
    digest = hashlib.sha256(f"{source_kind}:{source_id}".encode()).digest()[:16]
    encoded = base64.b32encode(digest).decode().lower().rstrip("=")
    return f"{prefix}_{encoded}"


def mime_type(filename: str, image_format: str, is_video: bool) -> str:
    guessed, _ = mimetypes.guess_type(filename)
    if guessed:
        return guessed
    normalized = image_format.lower()
    if is_video:
        return f"video/{normalized or 'mp4'}"
    if normalized == "jpg":
        normalized = "jpeg"
    return f"image/{normalized or 'jpeg'}"


def iso_or_none(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    # SmugMug commonly returns a timestamp without a timezone. Preserve the
    # wall-clock value and make the absence of timezone explicit.
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    if parsed.tzinfo is None:
        return parsed.isoformat(timespec="seconds")
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def timestamp_source(value: Any) -> dict[str, str | None]:
    raw = value.strip() if isinstance(value, str) and value.strip() else None
    normalized = iso_or_none(raw)
    timezone_status = "unknown"
    if raw:
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                timezone_status = "smugmug-api"
        except ValueError:
            pass
    return {
        "source_value": raw,
        "normalized": normalized,
        "timezone_status": timezone_status,
    }


def sanitized_asset(image: dict[str, Any], fallback_position: int) -> dict[str, Any]:
    image_key = str(image["ImageKey"])
    media_id = stable_id("kph", "smugmug-image", image_key)
    filename = str(image.get("FileName") or f"{image_key}.{str(image.get('Format') or 'jpg').lower()}")
    image_format = str(image.get("Format") or "")
    is_video = bool(image.get("IsVideo"))
    position = image.get("Position")
    if not isinstance(position, int):
        position = fallback_position
    return {
        "id": media_id,
        "position": position,
        "kind": "video" if is_video else "image",
        "source": {
            "service": "smugmug",
            "image_key": image_key,
            "web_uri": image.get("WebUri"),
            "filename": filename,
            "format": image_format,
            "archived_md5": image.get("ArchivedMD5"),
        },
        "display": {
            "title": image.get("Title") or "",
            "caption": image.get("Caption") or "",
            "alt": image.get("Title") or image.get("Caption") or filename,
        },
        "file": {
            "mime_type": mime_type(filename, image_format, is_video),
            "bytes": image.get("ArchivedSize") or image.get("OriginalSize"),
            "width": image.get("OriginalWidth"),
            "height": image.get("OriginalHeight"),
        },
        "timestamps": {
            "captured_at": timestamp_source(image.get("DateTimeOriginal")),
            "uploaded_at": timestamp_source(image.get("DateTimeUploaded")),
        },
        "destination": {
            "photo_path": f"/photos/{media_id}",
            "media_path": f"/media/{media_id}",
            "emdash_content_id": None,
            "emdash_media_id": None,
            "r2_object_key": None,
        },
        "verification": {
            "source_md5_verified": False,
            "sha256": None,
            "r2_roundtrip_verified": False,
        },
    }


def manifest(
    album: dict[str, Any],
    images: Iterable[dict[str, Any]],
    *,
    user: str,
    slug: str,
) -> dict[str, Any]:
    album_key = str(album["AlbumKey"])
    assets = [sanitized_asset(image, index) for index, image in enumerate(images, 1)]
    assets.sort(key=lambda item: (int(item["position"]), item["id"]))
    album_id = stable_id("kal", "smugmug-album", album_key)
    return {
        "manifest_version": 1,
        "generated_at": now_iso(),
        "scope": "public SmugMug album migration pilot",
        "privacy": {
            "public_assets_only": True,
            "signed_download_uris_persisted": False,
            "geolocation_persisted": False,
            "source_credentials_persisted": False,
        },
        "url_contract": {
            "album_path": f"/albums/{slug}",
            "photo_path_template": "/photos/{media_id}",
            "media_path_template": "/media/{media_id}",
        },
        "album": {
            "id": album_id,
            "slug": slug,
            "source": {
                "service": "smugmug",
                "user": user,
                "album_key": album_key,
                "web_uri": album.get("WebUri"),
            },
            "title": album.get("Title") or album.get("Name") or slug,
            "description": album.get("Description") or "",
            "sort_method": album.get("SortMethod"),
            "sort_direction": album.get("SortDirection"),
            "allow_downloads": bool(album.get("AllowDownloads")),
            "source_protected_flag": bool(album.get("Protected")),
            "asset_count": len(assets),
            "destination": {"emdash_content_id": None},
        },
        "assets": assets,
    }


def merge_verified_progress(
    fresh: dict[str, Any], existing: dict[str, Any]
) -> dict[str, Any]:
    if existing.get("album", {}).get("source", {}).get("album_key") != fresh.get(
        "album", {}
    ).get("source", {}).get("album_key"):
        raise ValueError("Existing manifest belongs to a different SmugMug album")
    existing_assets = {item.get("id"): item for item in existing.get("assets", [])}
    existing_album_content_id = (
        existing.get("album", {}).get("destination", {}).get("emdash_content_id")
    )
    if existing_album_content_id:
        fresh["album"]["destination"]["emdash_content_id"] = existing_album_content_id
    for asset in fresh.get("assets", []):
        previous = existing_assets.get(asset.get("id"))
        if not previous:
            continue
        same_source = (
            previous.get("source", {}).get("image_key")
            == asset.get("source", {}).get("image_key")
            and previous.get("source", {}).get("archived_md5")
            == asset.get("source", {}).get("archived_md5")
        )
        if not same_source:
            continue
        previous_key = previous.get("destination", {}).get("r2_object_key")
        if previous_key:
            asset["destination"]["r2_object_key"] = previous_key
        previous_media_id = previous.get("destination", {}).get("emdash_media_id")
        if previous_media_id:
            asset["destination"]["emdash_media_id"] = previous_media_id
        previous_content_id = previous.get("destination", {}).get("emdash_content_id")
        if previous_content_id:
            asset["destination"]["emdash_content_id"] = previous_content_id
        if previous.get("verification", {}).get("source_md5_verified"):
            asset["verification"] = previous["verification"]
    return fresh


def find_album(client: SmugMugClient, user: str, album_key: str) -> dict[str, Any]:
    for album in client.paged(f"/api/v2/user/{user}!albums", "Album"):
        if str(album.get("AlbumKey")) == album_key:
            return album
    raise SystemExit(f"Public album not found: {album_key}")


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def assert_sanitized(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FORBIDDEN_SOURCE_FIELDS:
                raise ValueError(f"Forbidden source field at {path}.{key}")
            assert_sanitized(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_sanitized(child, f"{path}[{index}]")
    elif isinstance(value, str):
        lowered = value.lower()
        if "api_key=" in lowered or "apikey=" in lowered:
            raise ValueError(f"Credential-bearing URL at {path}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--user", required=True, help="SmugMug nickname")
    result.add_argument("--album-key", required=True)
    result.add_argument("--slug", required=True)
    result.add_argument("--output", required=True)
    result.add_argument("--api-key-env", default="SMUGMUG_API_KEY")
    return result


def main() -> None:
    args = parser().parse_args()
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    client = SmugMugClient(api_key)
    album = find_album(client, args.user, args.album_key)
    images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
    if not images_uri:
        raise SystemExit("Album has no public AlbumImages URI")
    payload = manifest(
        album,
        client.paged(images_uri, "AlbumImage"),
        user=args.user,
        slug=args.slug,
    )
    output = Path(args.output)
    if output.exists():
        payload = merge_verified_progress(payload, json.loads(output.read_text()))
    assert_sanitized(payload)
    write_json_atomic(output, payload)


if __name__ == "__main__":
    main()
