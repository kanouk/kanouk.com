#!/usr/bin/env python3
"""Rank public SmugMug albums for a small, representative migration pilot."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import sys
from typing import Any

from audit_smugmug import SmugMugClient, now_iso


def album_score(summary: dict[str, Any]) -> int:
    assets = int(summary["assets"])
    score = 0
    score += 5 if 15 <= assets <= 60 else 2 if 5 <= assets <= 100 else 0
    score += 6 if summary["videos"] else 0
    score += 4 if summary["archived_uri"] == assets else -6
    score += 3 if summary["archived_md5"] == assets else -4
    score += 2 if summary["titles"] else 0
    score += 2 if summary["captions"] else 0
    score += 2 if summary["allow_downloads"] else 0
    score += 1 if summary["sort_method"] == "DateTimeOriginal" else 0
    score += 1 if not summary["protected"] else 0
    return score


def collect(args: argparse.Namespace) -> dict[str, Any]:
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    client = SmugMugClient(api_key)
    summaries: list[dict[str, Any]] = []
    albums_path = f"/api/v2/user/{args.user}!albums"

    for album in client.paged(albums_path, "Album"):
        images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
        formats: Counter[str] = Counter()
        assets = 0
        videos = 0
        titles = 0
        captions = 0
        archived_uri = 0
        archived_md5 = 0
        if images_uri:
            for image in client.paged(images_uri, "AlbumImage"):
                assets += 1
                formats[str(image.get("Format") or "unknown")] += 1
                videos += bool(image.get("IsVideo"))
                titles += bool(image.get("Title"))
                captions += bool(image.get("Caption"))
                archived_uri += bool(image.get("ArchivedUri"))
                archived_md5 += bool(image.get("ArchivedMD5"))

        summary = {
            "album_key": album.get("AlbumKey"),
            "name": album.get("Name"),
            "title": album.get("Title"),
            "web_uri": album.get("WebUri"),
            "url_name": album.get("UrlName"),
            "url_path": album.get("UrlPath"),
            "assets": assets,
            "formats": dict(sorted(formats.items())),
            "videos": videos,
            "titles": titles,
            "captions": captions,
            "archived_uri": archived_uri,
            "archived_md5": archived_md5,
            "allow_downloads": bool(album.get("AllowDownloads")),
            "protected": bool(album.get("Protected")),
            "sort_method": album.get("SortMethod"),
            "sort_direction": album.get("SortDirection"),
        }
        summary["score"] = album_score(summary)
        summaries.append(summary)

    summaries.sort(key=lambda item: (-int(item["score"]), int(item["assets"]), str(item["album_key"])))
    return {
        "report_version": 1,
        "source": "smugmug-public-api-v2",
        "generated_at": now_iso(),
        "user": args.user,
        "selection_scope": "public-api-readable; no media downloaded",
        "criteria": [
            "15-60 assets preferred",
            "at least one MP4 preferred",
            "all assets need ArchivedUri and ArchivedMD5",
            "titles and captions preferred",
            "downloads allowed and non-protected preferred",
        ],
        "albums": summaries,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--user", required=True, help="SmugMug nickname")
    result.add_argument(
        "--api-key-env",
        default="SMUGMUG_API_KEY",
        help="Environment variable containing the public API key",
    )
    result.add_argument("--limit", type=int, default=10)
    return result


def main() -> None:
    args = parser().parse_args()
    report = collect(args)
    report["albums"] = report["albums"][: max(args.limit, 1)]
    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
