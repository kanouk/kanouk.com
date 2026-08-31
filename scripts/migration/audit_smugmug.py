#!/usr/bin/env python3
"""Aggregate public SmugMug album and asset metadata without saving media."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Iterable
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sorted_counter(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items(), key=lambda pair: (-pair[1], pair[0])))


def increment(counter: Counter[str], value: Any) -> None:
    if isinstance(value, str) and value:
        counter[value] += 1


class SmugMugClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self.origin = "https://api.smugmug.com"
        self.headers = {
            "Accept": "application/json",
            "User-Agent": "kanouk-migration-audit/1.0",
        }

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        parsed = urlparse(path)
        if parsed.scheme or parsed.netloc:
            raise ValueError("SmugMug API paths must be relative")
        query = {"APIKey": self.api_key, **(params or {})}
        separator = "&" if "?" in path else "?"
        request = Request(
            f"{self.origin}{path}{separator}{urlencode(query)}",
            headers=self.headers,
        )
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                with urlopen(request, timeout=120) as response:
                    return json.loads(response.read())["Response"]
            except (TimeoutError, OSError) as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2**attempt)
        assert last_error is not None
        raise last_error

    def paged(self, path: str, key: str) -> Iterable[dict[str, Any]]:
        start = 1
        while True:
            response = self.get(path, {"start": start, "count": 50})
            records = response.get(key) or []
            yield from (record for record in records if isinstance(record, dict))
            pages = response.get("Pages") or {}
            total = int(pages.get("Total", len(records)))
            if start + len(records) > total or not records:
                return
            start += len(records)


def audit(args: argparse.Namespace) -> dict[str, Any]:
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    client = SmugMugClient(api_key)

    album_fields: Counter[str] = Counter()
    album_uri_fields: Counter[str] = Counter()
    image_fields: Counter[str] = Counter()
    image_uri_fields: Counter[str] = Counter()
    security_types: Counter[str] = Counter()
    sort_methods: Counter[str] = Counter()
    sort_directions: Counter[str] = Counter()
    formats: Counter[str] = Counter()
    image_statuses: Counter[str] = Counter()
    album_flags: Counter[str] = Counter()
    image_flags: Counter[str] = Counter()
    total_source_bytes = 0
    total_archived_bytes = 0
    assets_with_nonzero_coordinates = 0
    album_count = 0
    asset_count = 0

    albums_path = f"/api/v2/user/{args.user}!albums"
    for album in client.paged(albums_path, "Album"):
        album_count += 1
        album_fields.update(album.keys())
        album_uri_fields.update((album.get("Uris") or {}).keys())
        increment(security_types, album.get("SecurityType"))
        increment(sort_methods, album.get("SortMethod"))
        increment(sort_directions, album.get("SortDirection"))
        for field in (
            "AllowDownloads",
            "CanBuy",
            "CanFavorite",
            "CanShare",
            "EXIF",
            "External",
            "Filenames",
            "Geography",
            "HasDownloadPassword",
            "Protected",
        ):
            album_flags[f"{field}={bool(album.get(field))}"] += 1

        images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
        if not images_uri:
            continue
        for image in client.paged(images_uri, "AlbumImage"):
            asset_count += 1
            image_fields.update(image.keys())
            image_uri_fields.update((image.get("Uris") or {}).keys())
            increment(formats, image.get("Format"))
            increment(image_statuses, image.get("Status"))
            source_size = image.get("OriginalSize") or image.get("ArchivedSize") or 0
            if isinstance(source_size, int):
                total_source_bytes += source_size
            archived_size = image.get("ArchivedSize") or 0
            if isinstance(archived_size, int):
                total_archived_bytes += archived_size
            try:
                latitude = float(image.get("Latitude") or 0)
                longitude = float(image.get("Longitude") or 0)
                assets_with_nonzero_coordinates += bool(latitude or longitude)
            except (TypeError, ValueError):
                pass
            for field in (
                "ArchivedMD5",
                "ArchivedUri",
                "CanShare",
                "Caption",
                "Comments",
                "Hidden",
                "IsArchive",
                "IsVideo",
                "Keywords",
                "Protected",
                "ShowKeywords",
                "Title",
                "Watermarked",
            ):
                image_flags[f"has_{field}"] += bool(image.get(field))

    return {
        "report_version": 1,
        "source": "smugmug-public-api-v2",
        "generated_at": now_iso(),
        "user": args.user,
        "scope": "public-api-readable",
        "albums_total": album_count,
        "assets_total": asset_count,
        "total_source_bytes": total_source_bytes,
        "total_archived_bytes": total_archived_bytes,
        "assets_with_nonzero_coordinates": assets_with_nonzero_coordinates,
        "album_fields_seen": sorted_counter(album_fields),
        "album_uri_fields_seen": sorted_counter(album_uri_fields),
        "image_fields_seen": sorted_counter(image_fields),
        "image_uri_fields_seen": sorted_counter(image_uri_fields),
        "security_types": sorted_counter(security_types),
        "sort_methods": sorted_counter(sort_methods),
        "sort_directions": sorted_counter(sort_directions),
        "formats": sorted_counter(formats),
        "image_statuses": sorted_counter(image_statuses),
        "album_flags": sorted_counter(album_flags),
        "image_flags": sorted_counter(image_flags),
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--user", required=True, help="SmugMug nickname")
    result.add_argument(
        "--api-key-env",
        default="SMUGMUG_API_KEY",
        help="Environment variable containing the public API key",
    )
    result.add_argument("--output", help="JSON output path (stdout when omitted)")
    return result


def main() -> None:
    args = parser().parse_args()
    report = json.dumps(audit(args), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(report)
    else:
        sys.stdout.write(report)


if __name__ == "__main__":
    main()
