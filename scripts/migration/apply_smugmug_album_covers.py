#!/usr/bin/env python3
"""Record SmugMug listing covers and reapply them to existing EmDash albums.

Photos are never downloaded or uploaded. The command is idempotent: cover keys
are rewritten in place, and EmDash `cover_image` is updated only when the
published media id differs.
"""

from __future__ import annotations

import argparse
from collections import Counter
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
for import_root in (SCRIPT_ROOT, CLOUDFLARE_SCRIPTS):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from audit_smugmug import SmugMugClient  # noqa: E402
from build_smugmug_pilot_manifest import (  # noqa: E402
    album_highlight_image_key,
    album_node_cover_image_key,
    assert_sanitized,
    record_album_cover_fields,
    write_json_atomic,
)
from migrate_smugmug_album import (  # noqa: E402
    AlbumMigrationError,
    cover_media_id,
    ensure_album_cover,
    preferred_cover_asset,
)
from run_emdash_kanouk import (  # noqa: E402
    child_environment,
    load_credential,
    preflight,
)


PUBLIC_ALBUMS_URL = "https://photos.kanouk.com/albums"
PUBLIC_VERIFY_ATTEMPTS = 6


class AlbumCoverParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.covers: dict[str, str] = {}
        self._slug: str | None = None
        self._in_card = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "a" and attributes.get("class") == "album-card":
            href = attributes.get("href") or ""
            self._slug = href.rsplit("/", 1)[-1] or None
            self._in_card = True
        if tag == "img" and self._in_card and self._slug and self._slug not in self.covers:
            src = attributes.get("src") or ""
            if "/_yohaku/media/preview-v1/" in src:
                self.covers[self._slug] = src.rsplit("/", 1)[-1]

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_card:
            self._in_card = False
            self._slug = None


def first_asset_image_key(manifest: Mapping[str, Any]) -> str | None:
    assets = list(manifest.get("assets") or [])
    if not assets:
        return None
    key = assets[0].get("source", {}).get("image_key")
    return str(key) if isinstance(key, str) and key else None


def cover_storage_key(asset: Mapping[str, Any]) -> str | None:
    destination = asset.get("destination", {})
    key = destination.get("r2_object_key") or destination.get("poster_r2_object_key")
    return str(key) if isinstance(key, str) and key else None


def expected_public_covers(manifests: list[dict[str, Any]]) -> dict[str, str]:
    expected: dict[str, str] = {}
    for manifest in manifests:
        slug = str(manifest.get("album", {}).get("slug") or "")
        asset = preferred_cover_asset(manifest)
        storage_key = cover_storage_key(asset) if asset is not None else None
        if slug and storage_key:
            expected[slug] = storage_key
    return expected


def fetch_public_album_covers(url: str = PUBLIC_ALBUMS_URL) -> dict[str, str]:
    request = Request(
        url,
        headers={
            "User-Agent": "kanouk-album-cover-verifier/1.0",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urlopen(request, timeout=60) as response:
        html = response.read().decode("utf-8", errors="replace")
    parser = AlbumCoverParser()
    parser.feed(html)
    return parser.covers


def public_covers_match(
    expected: Mapping[str, str], actual: Mapping[str, str]
) -> list[str]:
    mismatches: list[str] = []
    for slug, storage_key in expected.items():
        preview = actual.get(slug)
        if not preview:
            mismatches.append(f"{slug}: missing public cover")
            continue
        if preview != storage_key and not preview.startswith(storage_key):
            mismatches.append(
                f"{slug}: public cover {preview} does not use {storage_key}"
            )
    return mismatches


def verify_public_album_covers(
    expected: Mapping[str, str], *, url: str = PUBLIC_ALBUMS_URL
) -> dict[str, Any]:
    last_mismatches = ["public album covers were not fetched"]
    actual: dict[str, str] = {}
    for attempt in range(1, PUBLIC_VERIFY_ATTEMPTS + 1):
        try:
            actual = fetch_public_album_covers(url)
            last_mismatches = public_covers_match(expected, actual)
            if not last_mismatches:
                return {
                    "ok": True,
                    "attempt": attempt,
                    "covers": len(actual),
                    "mismatches": [],
                }
        except (HTTPError, TimeoutError, URLError, OSError) as exc:
            last_mismatches = [f"public albums fetch failed: {exc}"]
        if attempt < PUBLIC_VERIFY_ATTEMPTS:
            time.sleep(min(2 ** (attempt - 1), 8))
    return {
        "ok": False,
        "attempt": PUBLIC_VERIFY_ATTEMPTS,
        "covers": len(actual),
        "mismatches": last_mismatches,
    }


def load_manifests(catalog_path: Path) -> list[tuple[Path, dict[str, Any]]]:
    catalog = json.loads(catalog_path.read_text())
    rows = []
    for row in catalog.get("albums", []):
        path = (catalog_path.parent / str(row["manifest"])).resolve()
        rows.append((path, json.loads(path.read_text())))
    return rows


def live_albums_by_key(client: SmugMugClient, user: str) -> dict[str, dict[str, Any]]:
    return {
        str(album.get("AlbumKey")): album
        for album in client.paged(f"/api/v2/user/{user}!albums", "Album")
        if album.get("AlbumKey")
    }


def refresh_cover_fields(
    manifest: dict[str, Any], album: Mapping[str, Any], client: SmugMugClient
) -> bool:
    source = manifest.setdefault("album", {}).setdefault("source", {})
    before = {
        "node_cover_image_key": source.get("node_cover_image_key"),
        "highlight_image_key": source.get("highlight_image_key"),
        "cover_image_key": source.get("cover_image_key"),
        "cover_image_source": source.get("cover_image_source"),
    }
    record_album_cover_fields(
        source,
        node_cover_image_key=album_node_cover_image_key(client, album),
        highlight_image_key=album_highlight_image_key(client, album),
        first_asset_key=first_asset_image_key(manifest),
    )
    after = {
        "node_cover_image_key": source.get("node_cover_image_key"),
        "highlight_image_key": source.get("highlight_image_key"),
        "cover_image_key": source.get("cover_image_key"),
        "cover_image_source": source.get("cover_image_source"),
    }
    return before != after


def record_stored_cover_fields(manifest: dict[str, Any]) -> bool:
    source = manifest.setdefault("album", {}).setdefault("source", {})
    before = dict(source)
    record_album_cover_fields(
        source,
        node_cover_image_key=source.get("node_cover_image_key"),
        highlight_image_key=source.get("highlight_image_key"),
        first_asset_key=first_asset_image_key(manifest),
    )
    return source != before


def cover_ready(manifest: Mapping[str, Any]) -> dict[str, Any]:
    asset = preferred_cover_asset(manifest)
    source = manifest.get("album", {}).get("source", {}) or {}
    return {
        "slug": manifest.get("album", {}).get("slug"),
        "title": manifest.get("album", {}).get("title"),
        "cover_image_key": source.get("cover_image_key"),
        "cover_image_source": source.get("cover_image_source"),
        "node_cover_image_key": source.get("node_cover_image_key"),
        "highlight_image_key": source.get("highlight_image_key"),
        "media_id": cover_media_id(asset) if asset is not None else None,
        "storage_key": cover_storage_key(asset) if asset is not None else None,
        "ready": asset is not None and cover_media_id(asset) is not None,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", required=True)
    result.add_argument("--user", default="kanolog")
    result.add_argument("--apply", action="store_true")
    result.add_argument("--refresh-from-smugmug", action="store_true")
    result.add_argument("--skip-public-verify", action="store_true")
    result.add_argument(
        "--public-albums-url",
        default=PUBLIC_ALBUMS_URL,
        help="Public albums URL used to confirm cache invalidation",
    )
    result.add_argument("--api-key-env", default="SMUGMUG_API_KEY")
    return result


def main() -> None:
    args = parser().parse_args()
    catalog_path = Path(args.catalog).resolve()
    rows = load_manifests(catalog_path)
    client: SmugMugClient | None = None
    live: dict[str, dict[str, Any]] = {}
    if args.refresh_from_smugmug:
        api_key = os.environ.get(args.api_key_env)
        if not api_key:
            raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
        client = SmugMugClient(api_key)
        live = live_albums_by_key(client, args.user)

    recorded = 0
    sources: Counter[str] = Counter()
    ready_rows: list[dict[str, Any]] = []
    for path, manifest in rows:
        album_key = str(manifest.get("album", {}).get("source", {}).get("album_key") or "")
        if client is not None:
            album = live.get(album_key)
            if album is None:
                raise SystemExit(f"Public album not found for cover refresh: {album_key}")
            changed = refresh_cover_fields(manifest, album, client)
        else:
            changed = record_stored_cover_fields(manifest)
        if changed:
            assert_sanitized(manifest)
            write_json_atomic(path, manifest)
            recorded += 1
        row = cover_ready(manifest)
        sources[str(row.get("cover_image_source") or "missing")] += 1
        ready_rows.append(row)

    missing_media = [row["slug"] for row in ready_rows if not row["ready"]]
    summary: dict[str, Any] = {
        "apply": bool(args.apply),
        "albums": len(rows),
        "covers_recorded": recorded,
        "cover_sources": dict(sources),
        "media_ready": sum(1 for row in ready_rows if row["ready"]),
        "missing_media": missing_media,
        "covers": ready_rows,
    }
    if missing_media:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        raise SystemExit("Cover media is missing for one or more albums")
    if not args.apply:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    credential = load_credential()
    env = child_environment(credential)
    preflight(env)
    updated = 0
    unchanged = 0
    for path, manifest in rows:
        # Re-read after recording so apply uses the checkpointed cover fields.
        manifest = json.loads(path.read_text())
        try:
            changed = ensure_album_cover(
                manifest, env=env, token=credential["token"]
            )
        except AlbumMigrationError as exc:
            summary["error"] = str(exc)
            summary["failed_slug"] = manifest.get("album", {}).get("slug")
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            raise SystemExit(1) from exc
        if changed:
            updated += 1
        else:
            unchanged += 1
    summary["cover_updated"] = updated
    summary["cover_already_current"] = unchanged
    if not args.skip_public_verify:
        expected = expected_public_covers(
            [json.loads(path.read_text()) for path, _ in rows]
        )
        public = verify_public_album_covers(
            expected, url=args.public_albums_url
        )
        summary["public_verify"] = public
        if not public["ok"]:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            raise SystemExit("Public album covers did not match after cache wait")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
