#!/usr/bin/env python3
"""Migrate one frozen SmugMug album manifest into EmDash staging.

The command is resumable. It checkpoints destination identifiers only after a
content item exists, and marks an asset verified only after the uploaded source
bytes can be downloaded from the Worker with the same SHA-256.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, BinaryIO, Mapping, Sequence
from urllib.parse import quote
from urllib.request import Request, urlopen


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
for import_root in (SCRIPT_ROOT, CLOUDFLARE_SCRIPTS):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from audit_smugmug import SmugMugClient, now_iso  # noqa: E402
from build_smugmug_pilot_manifest import (  # noqa: E402
    assert_sanitized,
    write_json_atomic,
)
from download_smugmug_pilot_asset import copy_and_hash  # noqa: E402
from run_emdash_kanouk import (  # noqa: E402
    EXPECTED_URL,
    WEB_ROOT,
    child_environment,
    load_credential,
    preflight,
)


class AlbumMigrationError(RuntimeError):
    pass


def source_extension(asset: Mapping[str, Any]) -> str:
    filename = str(asset.get("source", {}).get("filename") or "")
    suffix = Path(filename).suffix.lower()
    if suffix:
        return suffix
    mime = str(asset.get("file", {}).get("mime_type") or "")
    return mimetypes.guess_extension(mime) or (".mp4" if asset.get("kind") == "video" else ".jpg")


def run_emdash(
    args: Sequence[str], env: Mapping[str, str], *, token: str
) -> dict[str, Any]:
    result = subprocess.run(
        ["bunx", "emdash", *args, "--url", EXPECTED_URL, "--json"],
        cwd=WEB_ROOT,
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr.strip() or result.stdout.strip()).replace(token, "[redacted]")
        raise AlbumMigrationError(
            f"EmDash command failed ({result.returncode}): {detail[:500] or 'no diagnostic output'}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AlbumMigrationError("EmDash returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise AlbumMigrationError("EmDash returned an unexpected response")
    return payload


def find_live_assets(
    client: SmugMugClient, *, user: str, album_key: str
) -> dict[str, dict[str, Any]]:
    album: dict[str, Any] | None = None
    for candidate in client.paged(f"/api/v2/user/{user}!albums", "Album"):
        if str(candidate.get("AlbumKey")) == album_key:
            album = candidate
            break
    if album is None:
        raise AlbumMigrationError(f"Public album not found: {album_key}")
    images_uri = ((album.get("Uris") or {}).get("AlbumImages") or {}).get("Uri")
    if not images_uri:
        raise AlbumMigrationError("Album has no public AlbumImages URI")
    return {
        str(image.get("ImageKey")): image
        for image in client.paged(images_uri, "AlbumImage")
        if image.get("ImageKey")
    }


def download_source(
    live: Mapping[str, Any], expected_md5: str, destination: Path
) -> dict[str, Any]:
    archived_uri = live.get("ArchivedUri")
    live_md5 = str(live.get("ArchivedMD5") or "").lower()
    if not isinstance(archived_uri, str) or not archived_uri:
        raise AlbumMigrationError("Asset has no public ArchivedUri")
    if not expected_md5 or live_md5 != expected_md5:
        raise AlbumMigrationError("Live ArchivedMD5 does not match the frozen manifest")
    request = Request(archived_uri, headers={"User-Agent": "kanouk-migration/1.0"})
    with destination.open("wb") as output, urlopen(request, timeout=300) as response:
        hashes = copy_and_hash(response, output)
    if hashes["md5"] != expected_md5:
        raise AlbumMigrationError("Downloaded bytes do not match SmugMug ArchivedMD5")
    return hashes


def extract_metadata(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "exiftool",
            "-n",
            "-j",
            "-DateTimeOriginal",
            "-OffsetTimeOriginal",
            "-GPSLatitude",
            "-GPSLongitude",
            "-GPSAltitude",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    row: dict[str, Any] = {}
    if result.returncode == 0:
        rows = json.loads(result.stdout)
        if rows and isinstance(rows[0], dict):
            row = rows[0]
    latitude = row.get("GPSLatitude")
    longitude = row.get("GPSLongitude")
    location: dict[str, float] = {}
    if (
        isinstance(latitude, (int, float))
        and -90 <= float(latitude) <= 90
        and isinstance(longitude, (int, float))
        and -180 <= float(longitude) <= 180
    ):
        location = {"latitude": float(latitude), "longitude": float(longitude)}
        altitude = row.get("GPSAltitude")
        if isinstance(altitude, (int, float)):
            location["altitude"] = float(altitude)
    captured_at = None
    raw = row.get("DateTimeOriginal")
    offset = row.get("OffsetTimeOriginal")
    if isinstance(raw, str):
        try:
            parsed = datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
            captured_at = parsed.isoformat(timespec="seconds")
            if isinstance(offset, str) and len(offset) == 6 and offset[0] in "+-":
                captured_at += offset
        except ValueError:
            pass
    return {"location": location, "captured_at": captured_at}


def make_video_poster(source: Path, destination: Path) -> None:
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not destination.exists() or destination.stat().st_size == 0:
        raise AlbumMigrationError(
            f"Could not generate video poster: {(result.stderr or '').strip()[:300]}"
        )


def upload_media(
    path: Path,
    *,
    alt: str,
    env: Mapping[str, str],
    token: str,
) -> dict[str, Any]:
    payload = run_emdash(
        ["media", "upload", str(path), "--alt", alt], env, token=token
    )
    if not isinstance(payload.get("id"), str) or not isinstance(
        payload.get("storageKey"), str
    ):
        raise AlbumMigrationError("EmDash media upload omitted id or storage key")
    return payload


def content_payload(
    asset: Mapping[str, Any],
    *,
    album_id: str,
    source_media_id: str,
    poster_media_id: str | None,
    metadata: Mapping[str, Any],
    source_sha256: str,
) -> dict[str, Any]:
    display = asset.get("display", {})
    source = asset.get("source", {})
    kind = str(asset.get("kind"))
    alt = str(display.get("alt") or display.get("title") or source.get("filename") or "")
    captured_at = metadata.get("captured_at") or (
        asset.get("timestamps", {}).get("captured_at", {}).get("normalized")
    )
    payload: dict[str, Any] = {
        "title": str(display.get("title") or source.get("filename") or asset.get("id")),
        "kind": kind,
        "image": {
            "id": poster_media_id if kind == "video" else source_media_id,
            "provider": "local",
            "alt": alt,
        },
        "alt": alt,
        "caption": str(display.get("caption") or ""),
        "album": album_id,
        "position": int(asset.get("position") or 0),
        "captured_at": captured_at,
        "source_system": "smugmug",
        "source_id": str(source.get("image_key") or ""),
        "source_url": source.get("web_uri"),
        "original_sha256": source_sha256,
        "source_metadata": {
            "stable_media_id": asset.get("id"),
            "source_archived_md5": source.get("archived_md5"),
            "gps_exif_preserved": bool(metadata.get("location")),
            "gps_coordinates_stored": "emdash-fields" if metadata.get("location") else None,
            "public_metadata_policy": "Source EXIF retained",
            "migration": "manifest-v1",
        },
    }
    if kind == "video":
        payload["video"] = {
            "id": source_media_id,
            "provider": "local",
            "alt": alt,
        }
    payload.update(metadata.get("location") or {})
    return payload


def create_content(
    asset: Mapping[str, Any],
    data: Mapping[str, Any],
    *,
    env: Mapping[str, str],
    token: str,
) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".json", delete=False
    ) as handle:
        json.dump(data, handle, ensure_ascii=False)
        payload_path = Path(handle.name)
    try:
        result = run_emdash(
            [
                "content",
                "create",
                "photos",
                "--file",
                str(payload_path),
                "--slug",
                str(asset["id"]),
            ],
            env,
            token=token,
        )
    finally:
        payload_path.unlink(missing_ok=True)
    if not isinstance(result.get("id"), str):
        raise AlbumMigrationError("EmDash content create omitted its id")
    return result


def album_content_payload(album: Mapping[str, Any], assets: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    captured = sorted(
        value
        for asset in assets
        if isinstance(
            value := asset.get("timestamps", {}).get("captured_at", {}).get("normalized"),
            str,
        )
    )
    source = album.get("source", {})
    sort_method = str(album.get("sort_method") or "position").lower()
    sort_direction = str(album.get("sort_direction") or "ascending").lower()
    return {
        "title": str(album.get("title") or album.get("slug") or "Album"),
        "description": str(album.get("description") or ""),
        "captured_from": captured[0] if captured else None,
        "captured_to": captured[-1] if captured else None,
        "sort_method": "position" if sort_method == "position" else sort_method,
        "sort_direction": "desc" if sort_direction in {"descending", "desc"} else "asc",
        "allow_downloads": bool(album.get("allow_downloads")),
        "source_album_key": str(source.get("album_key") or ""),
        "source_url": source.get("web_uri"),
        "source_metadata": {
            "stable_album_id": album.get("id"),
            "source_protected_flag": bool(album.get("source_protected_flag")),
            "migration": "manifest-v1",
        },
    }


def ensure_album_content(
    manifest: dict[str, Any],
    *,
    manifest_path: Path,
    env: Mapping[str, str],
    token: str,
) -> str:
    album = manifest.get("album", {})
    destination = album.setdefault("destination", {})
    content_id = destination.get("emdash_content_id")
    if isinstance(content_id, str):
        result = run_emdash(
            ["content", "get", "albums", content_id, "--raw"], env, token=token
        )
        data = result.get("data")
        if not isinstance(data, dict) or data.get("source_album_key") != album.get(
            "source", {}
        ).get("album_key"):
            raise AlbumMigrationError("EmDash album readback mismatch")
        return content_id
    data = album_content_payload(album, manifest.get("assets", []))
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".json", delete=False
    ) as handle:
        json.dump(data, handle, ensure_ascii=False)
        payload_path = Path(handle.name)
    try:
        result = run_emdash(
            [
                "content",
                "create",
                "albums",
                "--file",
                str(payload_path),
                "--slug",
                str(album.get("slug")),
            ],
            env,
            token=token,
        )
    finally:
        payload_path.unlink(missing_ok=True)
    content_id = result.get("id")
    if not isinstance(content_id, str):
        raise AlbumMigrationError("EmDash album create omitted its id")
    destination["emdash_content_id"] = content_id
    checkpoint(manifest_path, manifest)
    return content_id


def ensure_album_cover(
    manifest: dict[str, Any], *, env: Mapping[str, str], token: str
) -> bool:
    album_id = manifest.get("album", {}).get("destination", {}).get("emdash_content_id")
    if not isinstance(album_id, str):
        return False
    first = next(
        (
            asset
            for asset in manifest.get("assets", [])
            if asset.get("verification", {}).get("r2_roundtrip_verified")
            and asset.get("destination", {}).get("emdash_media_id")
        ),
        None,
    )
    if first is None:
        return False
    destination = first.get("destination", {})
    cover_media_id = destination.get("poster_media_id") or destination.get(
        "emdash_media_id"
    )
    current = run_emdash(
        ["content", "get", "albums", album_id, "--raw"], env, token=token
    )
    data = current.get("data")
    revision = current.get("_rev")
    if not isinstance(data, dict) or not isinstance(revision, str):
        raise AlbumMigrationError("EmDash album cover readback has no revision")
    existing = data.get("cover_image")
    if isinstance(existing, dict) and existing.get("id") == cover_media_id:
        return False
    run_emdash(
        [
            "content",
            "update",
            "albums",
            album_id,
            "--rev",
            revision,
            "--data",
            json.dumps(
                {
                    "cover_image": {
                        "id": cover_media_id,
                        "provider": "local",
                        "alt": str(first.get("display", {}).get("alt") or ""),
                    }
                },
                ensure_ascii=False,
            ),
        ],
        env,
        token=token,
    )
    return True


def public_sha256(storage_key: str) -> tuple[str, int]:
    url = f"{EXPECTED_URL}/_emdash/api/media/file/{quote(storage_key, safe='')}"
    digest = hashlib.sha256()
    size = 0
    request = Request(url, headers={"User-Agent": "kanouk-migration-verifier/1.0"})
    with urlopen(request, timeout=300) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def verify_existing_content(
    asset: Mapping[str, Any], *, env: Mapping[str, str], token: str
) -> None:
    content_id = asset.get("destination", {}).get("emdash_content_id")
    if not isinstance(content_id, str):
        raise AlbumMigrationError("Asset has no EmDash content id")
    payload = run_emdash(
        ["content", "get", "photos", content_id, "--raw"], env, token=token
    )
    data = payload.get("data")
    if not isinstance(data, dict):
        raise AlbumMigrationError("EmDash content readback has no data")
    if data.get("source_id") != asset.get("source", {}).get("image_key"):
        raise AlbumMigrationError("EmDash source id readback mismatch")
    if data.get("original_sha256") != asset.get("verification", {}).get("sha256"):
        raise AlbumMigrationError("EmDash source SHA-256 readback mismatch")
    if data.get("kind") != asset.get("kind"):
        raise AlbumMigrationError("EmDash media kind readback mismatch")


def checkpoint(path: Path, manifest: dict[str, Any]) -> None:
    assert_sanitized(manifest)
    write_json_atomic(path, manifest)


def migrate_asset(
    asset: dict[str, Any],
    *,
    live: Mapping[str, Any],
    album_id: str,
    manifest_path: Path,
    manifest: dict[str, Any],
    env: Mapping[str, str],
    token: str,
) -> str:
    if asset.get("verification", {}).get("r2_roundtrip_verified") and asset.get(
        "destination", {}
    ).get("emdash_content_id"):
        return "skipped_verified"
    expected_md5 = str(asset.get("source", {}).get("archived_md5") or "").lower()
    with tempfile.TemporaryDirectory(prefix="kanouk-smugmug-") as directory:
        temp_root = Path(directory)
        source_file = temp_root / f"source{source_extension(asset)}"
        hashes = download_source(live, expected_md5, source_file)
        metadata = extract_metadata(source_file)
        verification = asset.setdefault("verification", {})
        verification["source_md5_verified"] = True
        verification["sha256"] = hashes["sha256"]

        destination = asset.setdefault("destination", {})
        if not destination.get("emdash_content_id"):
            uploaded_ids: list[str] = []
            try:
                source_media = upload_media(
                    source_file,
                    alt=str(asset.get("display", {}).get("alt") or ""),
                    env=env,
                    token=token,
                )
                uploaded_ids.append(str(source_media["id"]))
                poster_media: dict[str, Any] | None = None
                if asset.get("kind") == "video":
                    poster = temp_root / "poster.jpg"
                    make_video_poster(source_file, poster)
                    poster_media = upload_media(
                        poster,
                        alt=str(asset.get("display", {}).get("alt") or ""),
                        env=env,
                        token=token,
                    )
                    uploaded_ids.append(str(poster_media["id"]))
                data = content_payload(
                    asset,
                    album_id=album_id,
                    source_media_id=str(source_media["id"]),
                    poster_media_id=str(poster_media["id"]) if poster_media else None,
                    metadata=metadata,
                    source_sha256=str(hashes["sha256"]),
                )
                content = create_content(asset, data, env=env, token=token)
            except Exception:
                for media_id in reversed(uploaded_ids):
                    try:
                        run_emdash(["media", "delete", media_id], env, token=token)
                    except Exception:
                        pass
                raise
            destination["emdash_content_id"] = content["id"]
            destination["emdash_media_id"] = source_media["id"]
            destination["r2_object_key"] = source_media["storageKey"]
            if poster_media:
                destination["poster_media_id"] = poster_media["id"]
                destination["poster_r2_object_key"] = poster_media["storageKey"]
            checkpoint(manifest_path, manifest)

        storage_key = destination.get("r2_object_key")
        if not isinstance(storage_key, str):
            raise AlbumMigrationError("Asset has no destination storage key")
        public_hash, public_bytes = public_sha256(storage_key)
        if public_hash != hashes["sha256"] or public_bytes != hashes["bytes"]:
            raise AlbumMigrationError("Worker media readback does not match source bytes")
        verification.update(
            {
                "r2_roundtrip_verified": True,
                "verified_at": now_iso(),
                "public_asset": {
                    "sha256": public_hash,
                    "bytes": public_bytes,
                    "gps_present": bool(metadata.get("location")),
                    "gps_preserved": bool(metadata.get("location")),
                    "metadata_policy": "Source EXIF retained; coordinates stored outside Git",
                    "recorded_at": now_iso(),
                },
            }
        )
        verify_existing_content(asset, env=env, token=token)
        checkpoint(manifest_path, manifest)
        return "verified"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--manifest", required=True)
    result.add_argument("--limit", type=int)
    result.add_argument("--asset-id", action="append", default=[])
    result.add_argument("--apply", action="store_true")
    result.add_argument("--continue-on-error", action="store_true")
    result.add_argument("--api-key-env", default="SMUGMUG_API_KEY")
    return result


def main() -> None:
    args = parser().parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text())
    assert_sanitized(manifest)
    album = manifest.get("album", {})
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key environment variable: {args.api_key_env}")
    assets = list(manifest.get("assets", []))
    selected_ids = set(args.asset_id)
    if selected_ids:
        assets = [asset for asset in assets if asset.get("id") in selected_ids]
        missing = selected_ids - {str(asset.get("id")) for asset in assets}
        if missing:
            raise SystemExit("Unknown asset ids: " + ", ".join(sorted(missing)))
    if args.limit is not None:
        if args.limit < 1:
            raise SystemExit("--limit must be at least 1")
        assets = assets[: args.limit]
    pending = [
        asset
        for asset in assets
        if not asset.get("verification", {}).get("r2_roundtrip_verified")
    ]
    if not args.apply:
        print(
            json.dumps(
                {
                    "apply": False,
                    "selected": len(assets),
                    "pending": len(pending),
                    "images": sum(asset.get("kind") == "image" for asset in pending),
                    "videos": sum(asset.get("kind") == "video" for asset in pending),
                }
            )
        )
        return

    credential = load_credential()
    env = child_environment(credential)
    preflight(env)
    album_id = ensure_album_content(
        manifest,
        manifest_path=manifest_path,
        env=env,
        token=credential["token"],
    )
    live_assets = find_live_assets(
        SmugMugClient(api_key),
        user=str(album.get("source", {}).get("user")),
        album_key=str(album.get("source", {}).get("album_key")),
    )
    if len(live_assets) != int(album.get("asset_count") or 0):
        raise SystemExit("Live SmugMug asset count differs from frozen manifest")

    counts = {
        "verified": 0,
        "skipped_verified": 0,
        "pending_owner_auth": 0,
        "failed": 0,
    }
    for index, asset in enumerate(assets, 1):
        image_key = str(asset.get("source", {}).get("image_key") or "")
        live = live_assets.get(image_key)
        if live is None:
            raise SystemExit(f"Frozen asset is absent from live album: {image_key}")
        if not live.get("ArchivedUri") or not live.get("ArchivedMD5"):
            asset.setdefault("verification", {})["migration_status"] = "pending_owner_auth"
            counts["pending_owner_auth"] += 1
            checkpoint(manifest_path, manifest)
            print(
                f"[{index}/{len(assets)}] {asset['id']}: pending_owner_auth",
                flush=True,
            )
            continue
        try:
            status = migrate_asset(
                asset,
                live=live,
                album_id=album_id,
                manifest_path=manifest_path,
                manifest=manifest,
                env=env,
                token=credential["token"],
            )
            counts[status] += 1
            print(f"[{index}/{len(assets)}] {asset['id']}: {status}", flush=True)
        except Exception as exc:
            counts["failed"] += 1
            checkpoint(manifest_path, manifest)
            print(
                f"[{index}/{len(assets)}] {asset.get('id')}: failed: {exc}",
                file=sys.stderr,
                flush=True,
            )
            if not args.continue_on_error:
                raise SystemExit(1) from exc
    cover_updated = ensure_album_cover(
        manifest, env=env, token=credential["token"]
    )
    print(
        json.dumps(
            {"apply": True, "cover_updated": cover_updated, **counts},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
