#!/usr/bin/env python3
"""Build and dry-run a SmugMug-to-kanouk URL ledger for one blog article."""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import tempfile
from typing import Any
from urllib.parse import urlparse

from audit_smugmug import now_iso


URL_PATTERN = re.compile(r"https?://[^\s\)\]\>\"]+")
IMAGE_KEY_PATTERN = re.compile(r"/i-([A-Za-z0-9]+)/")
SMUGMUG_HOSTS = {"kanolog.smugmug.com", "photos.smugmug.com"}


def extract_smugmug_urls(text: str) -> list[str]:
    return [
        url
        for url in URL_PATTERN.findall(text)
        if (urlparse(url).hostname or "").lower() in SMUGMUG_HOSTS
    ]


def image_key(url: str) -> str | None:
    match = IMAGE_KEY_PATTERN.search(urlparse(url).path)
    return match.group(1) if match else None


def canonical_photo_path(asset: dict[str, Any]) -> str:
    return f"/p/{asset['id']}"


def build(
    manifest: dict[str, Any],
    article: str,
    *,
    article_id: str,
    article_url: str,
    destination_origin: str,
) -> tuple[dict[str, Any], str]:
    assets_by_key = {
        str(item["source"]["image_key"]): item for item in manifest["assets"]
    }
    grouped: dict[str, list[str]] = defaultdict(list)
    unmatched: list[str] = []
    replacements: dict[str, str] = {}
    for url in extract_smugmug_urls(article):
        key = image_key(url)
        if not key or key not in assets_by_key:
            unmatched.append(url)
            continue
        if url not in grouped[key]:
            grouped[key].append(url)
        asset = assets_by_key[key]
        host = (urlparse(url).hostname or "").lower()
        path = (
            asset["destination"]["media_path"]
            if host == "photos.smugmug.com"
            else canonical_photo_path(asset)
        )
        replacements[url] = f"{destination_origin.rstrip('/')}{path}"

    transformed = article
    for old_url in sorted(replacements, key=len, reverse=True):
        transformed = transformed.replace(old_url, replacements[old_url])
    remaining = extract_smugmug_urls(transformed)
    entries = []
    for key in sorted(grouped, key=lambda item: assets_by_key[item]["position"]):
        asset = assets_by_key[key]
        entries.append(
            {
                "source_image_key": key,
                "media_id": asset["id"],
                "old_urls": grouped[key],
                "new_photo_url": f"{destination_origin.rstrip('/')}{canonical_photo_path(asset)}",
                "new_media_url": f"{destination_origin.rstrip('/')}{asset['destination']['media_path']}",
            }
        )
    ledger = {
        "ledger_version": 1,
        "generated_at": now_iso(),
        "source_article": {"wordpress_id": article_id, "url": article_url},
        "destination_origin": destination_origin.rstrip("/"),
        "unique_assets": len(entries),
        "source_url_occurrences": len(extract_smugmug_urls(article)),
        "replacement_occurrences": sum(article.count(url) for url in replacements),
        "unmatched_urls": sorted(set(unmatched)),
        "remaining_smugmug_urls_after_dry_run": remaining,
        "entries": entries,
    }
    return ledger, transformed


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    temporary.replace(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--manifest", required=True)
    result.add_argument("--article", required=True)
    result.add_argument("--article-id", required=True)
    result.add_argument("--article-url", required=True)
    result.add_argument("--destination-origin", default="https://photos.kanouk.com")
    result.add_argument("--output", required=True)
    result.add_argument("--transformed-output")
    return result


def main() -> None:
    args = parser().parse_args()
    ledger, transformed = build(
        json.loads(Path(args.manifest).read_text()),
        Path(args.article).read_text(),
        article_id=args.article_id,
        article_url=args.article_url,
        destination_origin=args.destination_origin,
    )
    write_text_atomic(
        Path(args.output), json.dumps(ledger, ensure_ascii=False, indent=2) + "\n"
    )
    if args.transformed_output:
        write_text_atomic(Path(args.transformed_output), transformed)
    print(
        json.dumps(
            {
                key: ledger[key]
                for key in (
                    "unique_assets",
                    "source_url_occurrences",
                    "replacement_occurrences",
                    "unmatched_urls",
                    "remaining_smugmug_urls_after_dry_run",
                )
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
