#!/usr/bin/env python3
"""Backfill public SmugMug EXIF/keywords into already-migrated EmDash photos."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
for import_root in (SCRIPT_ROOT, REPO_ROOT / "scripts/cloudflare"):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from audit_smugmug import SmugMugClient, now_iso
from build_smugmug_pilot_manifest import write_json_atomic
from run_emdash_kanouk import EXPECTED_URL, child_environment, load_credential, preflight


NUMBER = re.compile(r"[-+]?\d+(?:\.\d+)?")
TRANSIENT_HTTP_STATUSES = {429, 502, 503, 504}


def text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return value
    candidate = text(value)
    if not candidate:
        return None
    if "/" in candidate:
        numerator, denominator = candidate.split("/", 1)
        try:
            parsed = float(numerator.strip()) / float(denominator.strip().split()[0])
            return parsed if math.isfinite(parsed) else None
        except (ValueError, ZeroDivisionError):
            pass
    match = NUMBER.search(candidate)
    if not match:
        return None
    parsed = float(match.group(0))
    return int(parsed) if parsed.is_integer() else parsed


def metadata_fields(payload: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    raw = payload.get("ImageMetadata")
    if not isinstance(raw, Mapping):
        return {}, []
    exif = {
        "Make": text(raw.get("Make")),
        "Model": text(raw.get("Model")),
        "LensModel": text(raw.get("Lens")),
        "FNumber": number(raw.get("Aperture")),
        "ExposureTime": number(raw.get("Exposure")),
        "ISO": number(raw.get("ISO")),
        "FocalLength": number(raw.get("FocalLength")),
        "ExposureCompensation": number(raw.get("ExposureCompensation")),
    }
    keywords = [
        keyword.strip()
        for keyword in re.split(r"[,;]", text(raw.get("Keywords")) or "")
        if keyword.strip()
    ]
    return {key: value for key, value in exif.items() if value is not None}, keywords


def emdash_request(
    method: str,
    path: str,
    token: str,
    payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    for attempt in range(1, 6):
        request = Request(
            EXPECTED_URL + "/_emdash/api" + path,
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "kanouk-smugmug-metadata-backfill/2.0",
            },
            method=method,
        )
        try:
            with urlopen(request, timeout=45) as response:
                value = json.load(response)
            if not isinstance(value, dict):
                raise RuntimeError("EmDash returned a non-object response")
            data = value.get("data", value)
            if not isinstance(data, dict):
                raise RuntimeError("EmDash returned an invalid response envelope")
            return data
        except HTTPError as exc:
            if attempt < 5 and exc.code in TRANSIENT_HTTP_STATUSES:
                time.sleep(min(0.5 * 2 ** (attempt - 1), 8))
                continue
            detail = exc.read(500).decode(errors="replace")
            raise RuntimeError(f"EmDash HTTP {exc.code}: {detail}") from exc
        except (TimeoutError, URLError) as exc:
            if attempt < 5:
                time.sleep(min(0.5 * 2 ** (attempt - 1), 8))
                continue
            raise RuntimeError(f"EmDash request failed: {exc}") from exc
    raise RuntimeError("EmDash retry loop exhausted")


def get_photo(content_id: str, token: str) -> dict[str, Any]:
    response = emdash_request("GET", f"/content/photos/{quote(content_id, safe='')}", token)
    item = response.get("item")
    if not isinstance(item, dict):
        raise RuntimeError(f"EmDash photo is missing: {content_id}")
    revision = response.get("_rev")
    if isinstance(revision, str):
        item["_rev"] = revision
    return item


def update_photo(
    asset: dict[str, Any],
    metadata: Mapping[str, Any],
    *,
    env: Mapping[str, str],
    token: str,
) -> bool:
    content_id = asset.get("destination", {}).get("emdash_content_id")
    if not isinstance(content_id, str):
        return False
    current = get_photo(content_id, token)
    data = current.get("data")
    revision = current.get("_rev")
    if not isinstance(data, dict) or not isinstance(revision, str):
        raise RuntimeError(f"EmDash photo has invalid readback: {asset.get('id')}")
    existing = data.get("source_metadata")
    source_metadata = dict(existing) if isinstance(existing, dict) else {}
    mapped_exif, keywords = metadata_fields(metadata)
    existing_exif = source_metadata.get("exif")
    exif = existing_exif if isinstance(existing_exif, dict) and existing_exif else mapped_exif
    if source_metadata.get("exif") == (exif or None) and source_metadata.get(
        "keywords"
    ) == (keywords or None):
        return False
    source_metadata["exif"] = exif or None
    source_metadata["keywords"] = keywords or None
    updated = emdash_request(
        "PUT",
        f"/content/photos/{quote(content_id, safe='')}",
        token,
        {"data": {"source_metadata": source_metadata}, "_rev": revision},
    )
    updated_item = updated.get("item")
    if isinstance(updated_item, dict) and updated_item.get("draftRevisionId"):
        emdash_request(
            "POST",
            f"/content/photos/{quote(content_id, safe='')}/publish",
            token,
            {},
        )
    readback = get_photo(content_id, token)
    readback_source = readback.get("data", {}).get("source_metadata")
    if not isinstance(readback_source, dict) or readback_source.get("exif") != (
        exif or None
    ):
        raise RuntimeError(f"EXIF readback mismatch: {asset.get('id')}")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--concurrency", type=int, default=6)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args()
    if args.concurrency < 1 or args.concurrency > 12:
        raise SystemExit("--concurrency must be between 1 and 12")
    catalog = json.loads(args.catalog.read_text())
    manifests = [
        (args.catalog.parent / row["manifest"]).resolve()
        for row in catalog.get("albums", [])
    ]
    pending = []
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text())
        for asset in manifest.get("assets", []):
            verification = asset.get("verification", {})
            if (
                verification.get("r2_roundtrip_verified")
                and not verification.get("metadata_backfilled_at")
            ):
                pending.append((manifest_path, asset.get("id")))
    if args.limit is not None:
        pending = pending[: max(0, args.limit)]
    if not args.apply:
        print(json.dumps({"apply": False, "pending": len(pending)}))
        return

    credential = load_credential()
    env = child_environment(credential)
    preflight(env)
    client = SmugMugClient(os.environ["SMUGMUG_API_KEY"])
    albums = {
        str(album.get("AlbumKey")): album
        for album in client.paged("/api/v2/user/kanolog!albums", "Album")
    }
    selected = set(pending)
    counts = {"updated": 0, "unchanged": 0, "failed": 0}
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text())
        selected_assets = [
            asset
            for asset in manifest.get("assets", [])
            if (manifest_path, asset.get("id")) in selected
        ]
        if not selected_assets:
            continue
        album_key = str(manifest.get("album", {}).get("source", {}).get("album_key"))
        album = albums.get(album_key)
        album_images = ((album or {}).get("Uris") or {}).get("AlbumImages") or {}
        images_uri = album_images.get("Uri")
        if not images_uri:
            raise RuntimeError(f"SmugMug album images are unavailable: {album_key}")
        live_assets = {
            str(image.get("ImageKey")): image
            for image in client.paged(images_uri, "AlbumImage")
        }
        def process_asset(asset: dict[str, Any]) -> tuple[dict[str, Any], bool, str]:
            image_key = str(asset.get("source", {}).get("image_key"))
            live = live_assets.get(image_key)
            metadata_uri = ((live or {}).get("Uris") or {}).get(
                "ImageMetadata", {}
            ).get("Uri")
            if not metadata_uri:
                raise RuntimeError(f"SmugMug metadata is unavailable: {asset.get('id')}")
            changed = update_photo(
                asset,
                client.get(metadata_uri),
                env=env,
                token=credential["token"],
            )
            return asset, changed, now_iso()

        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            futures = {executor.submit(process_asset, asset): asset for asset in selected_assets}
            for future in as_completed(futures):
                asset = futures[future]
                try:
                    _, changed, backfilled_at = future.result()
                    verification = asset.setdefault("verification", {})
                    verification["metadata_backfilled_at"] = backfilled_at
                    # Checkpoint only from the main thread so concurrent assets
                    # cannot overwrite each other's manifest progress.
                    write_json_atomic(manifest_path, manifest)
                    counts["updated" if changed else "unchanged"] += 1
                    print(f"{asset.get('id')}: {'updated' if changed else 'unchanged'}", flush=True)
                except Exception as exc:
                    counts["failed"] += 1
                    print(f"{asset.get('id')}: failed: {exc}", flush=True)
                    if not args.continue_on_error:
                        for pending_future in futures:
                            pending_future.cancel()
                        raise
    print(json.dumps({"apply": True, **counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
