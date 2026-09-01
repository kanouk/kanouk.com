#!/usr/bin/env python3
"""Build sanitized per-album manifests for every public SmugMug album."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import unquote, urlparse


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from audit_smugmug import SmugMugClient, now_iso  # noqa: E402
from build_smugmug_pilot_manifest import (  # noqa: E402
    album_highlight_image_key,
    assert_sanitized,
    manifest as album_manifest,
    merge_verified_progress,
    write_json_atomic,
)


def slugify(value: str, album_key: str) -> str:
    text = unquote(value).strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if not text:
        text = "album"
    if len(text) > 72:
        text = text[:72].rstrip("-")
    return text or f"album-{hashlib.sha256(album_key.encode()).hexdigest()[:8]}"


def album_slug(album: dict[str, Any]) -> str:
    title = str(album.get("Title") or album.get("Name") or "").strip()
    dated_title = re.fullmatch(r"(.+?),\s*(\d{4})/(\d{2})", title)
    if dated_title:
        subject = slugify(
            dated_title.group(1), str(album.get("AlbumKey") or "unknown")
        )
        return f"{dated_title.group(2)}-{dated_title.group(3)}-{subject}"
    web_uri = str(album.get("WebUri") or "")
    path_name = Path(urlparse(web_uri).path).name
    candidate = path_name or str(album.get("NiceName") or album.get("Name") or album.get("Title") or "")
    return slugify(candidate, str(album.get("AlbumKey") or "unknown"))


def unique_slug(base: str, album_key: str, used: set[str]) -> str:
    if base not in used:
        used.add(base)
        return base
    suffix = hashlib.sha256(album_key.encode()).hexdigest()[:8]
    value = f"{base}-{suffix}"
    used.add(value)
    return value


def build(
    *,
    user: str,
    output_dir: Path,
    api_key: str,
    progress_manifests: list[Path] | None = None,
) -> dict[str, Any]:
    client = SmugMugClient(api_key)
    albums = list(client.paged(f"/api/v2/user/{user}!albums", "Album"))
    albums.sort(key=lambda album: (str(album.get("DateTimeOriginal") or ""), str(album.get("AlbumKey") or "")))
    used: set[str] = set()
    progress_by_album_key: dict[str, dict[str, Any]] = {}
    for progress_path in progress_manifests or []:
        progress = json.loads(progress_path.read_text())
        key = str(progress.get("album", {}).get("source", {}).get("album_key") or "")
        if not key:
            raise ValueError(f"Progress manifest has no source album key: {progress_path}")
        progress_by_album_key[key] = progress
    index_rows: list[dict[str, Any]] = []
    for album in albums:
        album_key = str(album.get("AlbumKey") or "")
        slug = unique_slug(album_slug(album), album_key, used)
        images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
        images = list(client.paged(images_uri, "AlbumImage")) if images_uri else []
        payload = album_manifest(
            album,
            images,
            user=user,
            slug=slug,
            highlight_image_key=album_highlight_image_key(client, album),
        )
        payload["scope"] = "public SmugMug album migration"
        path = output_dir / slug / "manifest.json"
        if path.exists():
            payload = merge_verified_progress(payload, json.loads(path.read_text()))
        if album_key in progress_by_album_key:
            payload = merge_verified_progress(payload, progress_by_album_key[album_key])
        assert_sanitized(payload)
        write_json_atomic(path, payload)
        index_rows.append(
            {
                "slug": slug,
                "manifest": f"albums/{slug}/manifest.json",
                "album_id": payload["album"]["id"],
                "source_album_key": album_key,
                "source_url": album.get("WebUri"),
                "title": payload["album"]["title"],
                "asset_count": len(images),
                "downloadable_originals": sum(
                    bool(image.get("ArchivedUri") and image.get("ArchivedMD5")) for image in images
                ),
                "images": sum(not bool(image.get("IsVideo")) for image in images),
                "videos": sum(bool(image.get("IsVideo")) for image in images),
            }
        )
    catalog = {
        "catalog_version": 1,
        "generated_at": now_iso(),
        "scope": "smugmug-public-api-readable",
        "user": user,
        "albums_total": len(index_rows),
        "assets_total": sum(row["asset_count"] for row in index_rows),
        "downloadable_originals": sum(row["downloadable_originals"] for row in index_rows),
        "albums": index_rows,
    }
    assert_sanitized(catalog)
    write_json_atomic(output_dir.parent / "catalog.json", catalog)
    return catalog


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--user", required=True)
    result.add_argument("--output-dir", required=True)
    result.add_argument("--progress-manifest", action="append", default=[])
    result.add_argument("--api-key-env", default="SMUGMUG_API_KEY")
    return result


def main() -> None:
    args = parser().parse_args()
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    catalog = build(
        user=args.user,
        output_dir=Path(args.output_dir),
        api_key=api_key,
        progress_manifests=[Path(value) for value in args.progress_manifest],
    )
    print(
        json.dumps(
            {
                "albums": catalog["albums_total"],
                "assets": catalog["assets_total"],
                "downloadable_originals": catalog["downloadable_originals"],
            }
        )
    )


if __name__ == "__main__":
    main()
