#!/usr/bin/env python3
"""Diagnose one public SmugMug asset without persisting media or URLs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from typing import Any
from urllib.request import Request, urlopen

from audit_smugmug import SmugMugClient


def shape(value: Any, depth: int = 0) -> Any:
    if depth >= 3:
        return type(value).__name__
    if isinstance(value, dict):
        return {
            key: shape(child, depth + 1)
            for key, child in value.items()
            if "uri" not in key.lower() and "url" not in key.lower()
        }
    if isinstance(value, list):
        return {
            "type": "list",
            "count": len(value),
            "item": shape(value[0], depth + 1) if value else None,
        }
    return type(value).__name__


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True)
    parser.add_argument("--album-key", required=True)
    parser.add_argument("--image-key", required=True)
    parser.add_argument("--api-key-env", default="SMUGMUG_API_KEY")
    args = parser.parse_args()
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    client = SmugMugClient(api_key)
    album = next(
        (
            item
            for item in client.paged(f"/api/v2/user/{args.user}!albums", "Album")
            if str(item.get("AlbumKey")) == args.album_key
        ),
        None,
    )
    if not album:
        raise SystemExit("Album not found")
    images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
    image = next(
        (
            item
            for item in client.paged(images_uri, "AlbumImage")
            if str(item.get("ImageKey")) == args.image_key
        ),
        None,
    )
    if not image:
        raise SystemExit("Image not found")
    archived_uri = image.get("ArchivedUri")
    if not isinstance(archived_uri, str) or not archived_uri:
        raise SystemExit("No public ArchivedUri")
    digest = hashlib.md5()
    downloaded = 0
    request = Request(
        archived_uri,
        headers={"User-Agent": "kanouk-migration-diagnostic/1.0"},
    )
    with urlopen(request, timeout=300) as response:
        content_type = response.headers.get("Content-Type")
        content_length = response.headers.get("Content-Length")
        first_bytes = b""
        while chunk := response.read(1024 * 1024):
            if not first_bytes:
                first_bytes = chunk[:16]
            downloaded += len(chunk)
            digest.update(chunk)
    size_uri = ((image.get("Uris") or {}).get("ImageSizeDetails") or {}).get("Uri")
    size_details = client.get(size_uri) if size_uri else {}
    print(
        json.dumps(
            {
                "image_key": args.image_key,
                "format": image.get("Format"),
                "expected_bytes": image.get("ArchivedSize"),
                "downloaded_bytes": downloaded,
                "content_length": content_length,
                "content_type": content_type,
                "md5_match": digest.hexdigest().lower()
                == str(image.get("ArchivedMD5") or "").lower(),
                "magic_hex": first_bytes.hex(),
                "size_details_shape": shape(size_details),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
