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
import time
from typing import Any, BinaryIO, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlparse
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
from run_wrangler_kanouk import (  # noqa: E402
    GuardError as CloudflareGuardError,
    WRANGLER_BIN,
    child_environment as cloudflare_environment,
    load_credential as load_cloudflare_credential,
    validate_whoami,
)


class AlbumMigrationError(RuntimeError):
    pass


class OwnerAuthenticationRequired(AlbumMigrationError):
    """The public SmugMug response cannot provide the byte-exact original."""


TRANSIENT_MARKERS = ("HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504", "1102")


def is_transient_error(exc: BaseException) -> bool:
    if isinstance(exc, (TimeoutError, URLError, OSError)):
        return True
    if isinstance(exc, HTTPError):
        return exc.code in {429, 500, 502, 503, 504}
    return any(marker in str(exc) for marker in TRANSIENT_MARKERS)


def retry_delay(attempt: int) -> float:
    return min(2 ** (attempt - 1), 16)


def public_media_path(storage_key: str) -> str:
    return f"/_emdash/api/media/file/{quote(storage_key, safe='')}"


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


def get_content_by_identifier(
    collection: str,
    identifier: str,
    *,
    env: Mapping[str, str],
    token: str,
) -> dict[str, Any] | None:
    """Read content by id or slug, returning None only for a real 404."""
    for attempt in range(1, 6):
        result = subprocess.run(
            [
                "bunx",
                "emdash",
                "content",
                "get",
                collection,
                identifier,
                "--raw",
                "--url",
                EXPECTED_URL,
                "--json",
            ],
            cwd=WEB_ROOT,
            env=dict(env),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            try:
                payload = json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                raise AlbumMigrationError("EmDash returned invalid content JSON") from exc
            if not isinstance(payload, dict):
                raise AlbumMigrationError("EmDash returned an unexpected content response")
            return payload
        detail = (result.stderr.strip() or result.stdout.strip()).replace(
            token, "[redacted]"
        )
        if "Content item not found:" in detail:
            return None
        error = AlbumMigrationError(
            f"EmDash content read failed ({result.returncode}): "
            f"{detail[:500] or 'no diagnostic output'}"
        )
        if attempt == 5 or not is_transient_error(error):
            raise error
        time.sleep(retry_delay(attempt))
    raise AssertionError("unreachable")


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
    live: Mapping[str, Any],
    expected_md5: str,
    destination: Path,
    *,
    client: SmugMugClient | None = None,
) -> dict[str, Any]:
    """Download raw media and establish a fail-closed integrity receipt.

    Public migration requires the frozen manifest MD5. Owner migration uses the
    officially documented ImageSizeOriginal URL. SmugMug occasionally serves
    stable raw bytes whose digest differs from its ArchivedMD5; that case is
    accepted only after a second, freshly resolved owner download is identical.
    """
    owner_authenticated = bool(client and client.owner_authenticated)
    live_md5 = str(live.get("ArchivedMD5") or "").lower()
    if expected_md5 and live_md5 != expected_md5:
        raise AlbumMigrationError("Live ArchivedMD5 does not match the frozen manifest")
    if not expected_md5 and not owner_authenticated:
        raise OwnerAuthenticationRequired("Public manifest has no ArchivedMD5")
    if not live_md5:
        raise AlbumMigrationError("SmugMug owner response has no ArchivedMD5")

    def owner_original() -> tuple[str, bool]:
        assert client is not None
        size_uri = ((live.get("Uris") or {}).get("ImageSizeDetails") or {}).get(
            "Uri"
        )
        if not size_uri:
            raise AlbumMigrationError("Owner response has no ImageSizeDetails URI")
        size_response = client.get(size_uri)
        original = (size_response.get("ImageSizeDetails") or {}).get(
            "ImageSizeOriginal"
        ) or {}
        uri = original.get("Url") or original.get("URL") or original.get("Uri")
        if not isinstance(uri, str) or not uri:
            raise AlbumMigrationError("Owner original media URL is unavailable")
        return uri, bool(original.get("OwnerOnly"))

    def fetch(uri: str, target: Path) -> dict[str, Any]:
        hashes: dict[str, Any] | None = None
        for attempt in range(1, 6):
            request = Request(uri, headers={"User-Agent": "kanouk-migration/1.0"})
            try:
                with target.open("wb") as output, urlopen(
                    request, timeout=300
                ) as response:
                    hashes = copy_and_hash(response, output)
                break
            except (HTTPError, TimeoutError, URLError, OSError) as exc:
                target.unlink(missing_ok=True)
                if attempt == 5 or not is_transient_error(exc):
                    raise AlbumMigrationError(
                        f"SmugMug source download failed: {exc}"
                    ) from exc
                time.sleep(retry_delay(attempt))
        if hashes is None:
            raise AssertionError("unreachable")
        return hashes

    if owner_authenticated:
        download_uri, owner_only = owner_original()
        download_method = "owner_image_size_original"
    else:
        download_uri = live.get("ArchivedUri")
        owner_only = False
        download_method = "public_archived_uri"
        if not isinstance(download_uri, str) or not download_uri:
            raise OwnerAuthenticationRequired("Asset has no public ArchivedUri")

    hashes = fetch(download_uri, destination)
    reported_md5_match = hashes["md5"] == live_md5
    repeated_download_match = False
    if not reported_md5_match:
        if not owner_authenticated:
            destination.unlink(missing_ok=True)
            raise OwnerAuthenticationRequired(
                "Public ArchivedUri bytes do not match SmugMug ArchivedMD5"
            )
        second_uri, _ = owner_original()
        repeat_path = destination.with_name(destination.name + ".recheck")
        try:
            repeat_hashes = fetch(second_uri, repeat_path)
            repeated_download_match = (
                repeat_hashes["sha256"] == hashes["sha256"]
                and repeat_hashes["bytes"] == hashes["bytes"]
            )
        finally:
            repeat_path.unlink(missing_ok=True)
        if not repeated_download_match:
            destination.unlink(missing_ok=True)
            raise AlbumMigrationError("Owner original bytes changed during revalidation")

    hashes.update(
        {
            "download_method": download_method,
            "owner_only": owner_only,
            "smugmug_reported_md5": live_md5,
            "smugmug_reported_bytes": live.get("ArchivedSize")
            or live.get("OriginalSize"),
            "reported_md5_match": reported_md5_match,
            "repeated_download_match": repeated_download_match,
        }
    )
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
            "-Make",
            "-Model",
            "-LensModel",
            "-FNumber",
            "-ExposureTime",
            "-ISO",
            "-FocalLength",
            "-ExposureCompensation",
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
        and (float(latitude) != 0 or float(longitude) != 0)
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
    exif = {
        key: row[key]
        for key in (
            "Make",
            "Model",
            "LensModel",
            "FNumber",
            "ExposureTime",
            "ISO",
            "FocalLength",
            "ExposureCompensation",
        )
        if row.get(key) not in (None, "")
    }
    return {
        "location": location,
        "location_source": "embedded_exif" if location else None,
        "captured_at": captured_at,
        "exif": exif,
    }


def numeric_coordinate(value: Any, minimum: float, maximum: float) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if minimum <= parsed <= maximum else None


def merge_owner_location(
    extracted: dict[str, Any],
    live: Mapping[str, Any],
    metadata_payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Preserve SmugMug map coordinates when delivery EXIF omits them."""
    if extracted.get("location"):
        return extracted
    raw_metadata = metadata_payload.get("ImageMetadata")
    metadata = raw_metadata if isinstance(raw_metadata, Mapping) else {}
    latitude = numeric_coordinate(live.get("Latitude"), -90, 90)
    if latitude is None:
        latitude = numeric_coordinate(metadata.get("Latitude"), -90, 90)
    longitude = numeric_coordinate(live.get("Longitude"), -180, 180)
    if longitude is None:
        longitude = numeric_coordinate(metadata.get("Longitude"), -180, 180)
    if latitude is None or longitude is None:
        return extracted
    if latitude == 0 and longitude == 0:
        return extracted
    location: dict[str, float] = {
        "latitude": latitude,
        "longitude": longitude,
    }
    altitude = numeric_coordinate(live.get("Altitude"), -1500, 100000)
    if altitude is None:
        altitude = numeric_coordinate(metadata.get("Altitude"), -1500, 100000)
    if altitude is not None:
        location["altitude"] = altitude
    return {**extracted, "location": location, "location_source": "smugmug_owner_api"}


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
    width: int | None = None,
    height: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] | None = None
    for attempt in range(1, 6):
        try:
            payload = direct_media_upload(
                path,
                alt=alt,
                token=token,
                width=width,
                height=height,
            )
            break
        except AlbumMigrationError as exc:
            transient = any(
                marker in str(exc)
                for marker in (
                    "Service Unavailable",
                    "HTTP 429",
                    "HTTP 502",
                    "HTTP 503",
                    "HTTP 504",
                    "Connection reset by peer",
                )
            )
            if not transient or attempt == 5:
                raise
            time.sleep(min(2 ** (attempt - 1), 16))
    if payload is None:
        raise AlbumMigrationError("EmDash media upload retry loop exhausted")
    if not isinstance(payload.get("id"), str) or not isinstance(
        payload.get("storageKey"), str
    ):
        raise AlbumMigrationError("EmDash media upload omitted id or storage key")
    return payload


def media_api_json(
    path: str,
    *,
    token: str,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    request = Request(
        urljoin(EXPECTED_URL, path),
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
            "User-Agent": "kanouk-smugmug-migration/2.0",
        },
    )
    try:
        with urlopen(request, timeout=180) as response:
            result = json.loads(response.read())
    except HTTPError as exc:
        detail = exc.read(500).decode(errors="replace")
        raise AlbumMigrationError(f"EmDash media HTTP {exc.code}: {detail}") from exc
    except (TimeoutError, URLError) as exc:
        raise AlbumMigrationError(f"EmDash media request failed: {exc}") from exc
    if not isinstance(result, dict):
        raise AlbumMigrationError("EmDash media API returned a non-object response")
    data = result.get("data", result)
    if not isinstance(data, dict):
        raise AlbumMigrationError("EmDash media API returned invalid data")
    return data


def put_media_bytes(
    upload_url: str,
    headers: Mapping[str, Any],
    data: bytes,
    *,
    token: str,
) -> None:
    target = urljoin(EXPECTED_URL, upload_url)
    request_headers = {
        str(key): str(value) for key, value in headers.items()
    }
    if urlparse(target).netloc == urlparse(EXPECTED_URL).netloc:
        request_headers["Authorization"] = f"Bearer {token}"
    request_headers.setdefault("Content-Length", str(len(data)))
    request_headers.setdefault("User-Agent", "kanouk-smugmug-migration/2.0")
    request = Request(target, data=data, method="PUT", headers=request_headers)
    try:
        with urlopen(request, timeout=300) as response:
            response.read()
    except HTTPError as exc:
        detail = exc.read(500).decode(errors="replace")
        raise AlbumMigrationError(f"EmDash media PUT HTTP {exc.code}: {detail}") from exc
    except (TimeoutError, URLError) as exc:
        raise AlbumMigrationError(f"EmDash media PUT failed: {exc}") from exc


def direct_media_upload(
    path: Path,
    *,
    alt: str,
    token: str,
    width: int | None = None,
    height: int | None = None,
) -> dict[str, Any]:
    data = path.read_bytes()
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    upload_request: dict[str, Any] = {
        "filename": path.name,
        "contentType": mime_type,
        "size": len(data),
    }
    if data and len(data) <= 8 * 1024 * 1024:
        upload_request["contentHash"] = "sha1:" + hashlib.sha1(data).hexdigest()
    upload = media_api_json(
        "/_emdash/api/media/upload-url",
        token=token,
        method="POST",
        payload=upload_request,
    )
    media_id = upload.get("mediaId")
    if not isinstance(media_id, str):
        raise AlbumMigrationError("EmDash upload target omitted media id")
    if upload.get("existing") is not True:
        upload_url = upload.get("uploadUrl")
        if not isinstance(upload_url, str):
            raise AlbumMigrationError("EmDash upload target omitted upload URL")
        put_media_bytes(
            upload_url,
            upload.get("headers", {}),
            data,
            token=token,
        )
        confirmation: dict[str, Any] = {"size": len(data)}
        if isinstance(width, int) and width > 0:
            confirmation["width"] = width
        if isinstance(height, int) and height > 0:
            confirmation["height"] = height
        try:
            confirmed = media_api_json(
                f"/_emdash/api/media/{quote(media_id, safe='')}/confirm",
                token=token,
                method="POST",
                payload=confirmation,
            )
            item = confirmed.get("item")
        except AlbumMigrationError as exc:
            if "HTTP 503" not in str(exc) and "1102" not in str(exc):
                raise
            pending = media_api_json(
                f"/_emdash/api/media/{quote(media_id, safe='')}", token=token
            ).get("item")
            if not isinstance(pending, dict):
                raise AlbumMigrationError(
                    "EmDash confirm fallback could not read pending media"
                ) from exc
            item = finalize_pending_media(
                pending,
                source_bytes=data,
                alt=alt,
                width=width,
                height=height,
                token=token,
            )
    else:
        existing = media_api_json(
            f"/_emdash/api/media/{quote(media_id, safe='')}", token=token
        )
        item = existing.get("item")
    if not isinstance(item, dict):
        raise AlbumMigrationError("EmDash media confirmation omitted item")
    if alt:
        updated = media_api_json(
            f"/_emdash/api/media/{quote(media_id, safe='')}",
            token=token,
            method="PUT",
            payload={"alt": alt},
        )
        item = updated.get("item", item)
    if not isinstance(item.get("id"), str) or not isinstance(
        item.get("storageKey"), str
    ):
        raise AlbumMigrationError("EmDash media item omitted id or storage key")
    return item


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def guarded_cloudflare_environment() -> dict[str, str]:
    credential = load_cloudflare_credential()
    env = cloudflare_environment(credential)
    result = subprocess.run(
        [str(WRANGLER_BIN), "whoami", "--json"],
        cwd=WEB_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AlbumMigrationError("Wrangler authentication preflight failed")
    try:
        validate_whoami(json.loads(result.stdout), credential)
    except (json.JSONDecodeError, CloudflareGuardError) as exc:
        raise AlbumMigrationError("Wrangler account validation failed") from exc
    return env


def finalize_pending_media(
    item: Mapping[str, Any],
    *,
    source_bytes: bytes,
    alt: str,
    width: int | None,
    height: int | None,
    token: str,
) -> dict[str, Any]:
    """Finish a verified R2 upload when placeholder enrichment exhausts CPU."""
    media_id = item.get("id")
    storage_key = item.get("storageKey")
    if item.get("status") == "ready" and isinstance(media_id, str):
        return dict(item)
    if (
        item.get("status") != "pending"
        or not isinstance(media_id, str)
        or not isinstance(storage_key, str)
        or item.get("size") != len(source_bytes)
    ):
        raise AlbumMigrationError("EmDash confirm fallback rejected pending media state")
    expected_content_hash = "sha1:" + hashlib.sha1(source_bytes).hexdigest()
    if item.get("contentHash") != expected_content_hash:
        raise AlbumMigrationError("EmDash confirm fallback rejected content hash")
    expected_sha256 = hashlib.sha256(source_bytes).hexdigest()
    public_hash, public_bytes = public_sha256(storage_key)
    if public_hash != expected_sha256 or public_bytes != len(source_bytes):
        raise AlbumMigrationError("EmDash confirm fallback rejected R2 bytes")

    assignments = [
        "status='ready'",
        f"size={len(source_bytes)}",
        f"content_hash={sql_text(expected_content_hash)}",
        f"alt={sql_text(alt)}" if alt else "alt=NULL",
    ]
    if isinstance(width, int) and width > 0:
        assignments.append(f"width={width}")
    if isinstance(height, int) and height > 0:
        assignments.append(f"height={height}")
    statement = (
        f"UPDATE media SET {', '.join(assignments)} "
        f"WHERE id={sql_text(media_id)} AND status='pending' "
        f"AND storage_key={sql_text(storage_key)} AND size={len(source_bytes)}"
    )
    wrangler_env = guarded_cloudflare_environment()
    result = subprocess.run(
        [
            "bunx",
            "wrangler",
            "d1",
            "execute",
            "kanouk-content-staging",
            "--remote",
            "--config",
            "wrangler.jsonc",
            "--command",
            statement,
            "--json",
        ],
        cwd=WEB_ROOT,
        env=wrangler_env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AlbumMigrationError("Cloudflare-guarded media finalization failed")
    try:
        rows = json.loads(result.stdout)
        changes = rows[0]["meta"]["changes"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        raise AlbumMigrationError("Media finalization returned invalid D1 results") from exc
    if changes != 1:
        raise AlbumMigrationError(
            f"Media finalization changed {changes} rows instead of exactly one"
        )
    readback = media_api_json(
        f"/_emdash/api/media/{quote(media_id, safe='')}", token=token
    ).get("item")
    if (
        not isinstance(readback, dict)
        or readback.get("status") != "ready"
        or readback.get("storageKey") != storage_key
    ):
        raise AlbumMigrationError("Media finalization readback mismatch")
    return readback


def content_payload(
    asset: Mapping[str, Any],
    *,
    album_id: str,
    source_media_id: str,
    poster_media_id: str | None,
    metadata: Mapping[str, Any],
    source_sha256: str,
    source_integrity: Mapping[str, Any] | None = None,
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
            "gps_exif_preserved": bool(metadata.get("location"))
            and metadata.get("location_source", "embedded_exif") == "embedded_exif",
            "gps_preserved": bool(metadata.get("location")),
            "gps_coordinate_source": metadata.get("location_source"),
            "gps_coordinates_stored": "emdash-fields" if metadata.get("location") else None,
            "public_metadata_policy": "Source EXIF retained",
            "exif": metadata.get("exif") or None,
            "source_integrity": dict(source_integrity or {}) or None,
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
        result: dict[str, Any] | None = None
        for attempt in range(1, 6):
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
                break
            except AlbumMigrationError as exc:
                existing = get_content_by_identifier(
                    "photos", str(asset["id"]), env=env, token=token
                )
                if existing is not None:
                    existing_data = existing.get("data")
                    if (
                        not isinstance(existing_data, dict)
                        or existing_data.get("source_system") != data.get("source_system")
                        or existing_data.get("source_id") != data.get("source_id")
                        or existing_data.get("original_sha256")
                        != data.get("original_sha256")
                        or existing_data.get("kind") != data.get("kind")
                        or existing_data.get("album") != data.get("album")
                        or existing_data.get("source_metadata", {}).get(
                            "stable_media_id"
                        )
                        != data.get("source_metadata", {}).get("stable_media_id")
                    ):
                        raise AlbumMigrationError(
                            "Recovered EmDash photo does not match the attempted create"
                        ) from exc
                    return existing
                if attempt == 5 or not is_transient_error(exc):
                    raise
                time.sleep(retry_delay(attempt))
    finally:
        payload_path.unlink(missing_ok=True)
    if result is None:
        raise AssertionError("unreachable")
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
        result = get_content_by_identifier(
            "albums", content_id, env=env, token=token
        )
        if result is None:
            raise AlbumMigrationError("EmDash album readback was not found")
        data = result.get("data")
        if not isinstance(data, dict) or data.get("source_album_key") != album.get(
            "source", {}
        ).get("album_key"):
            raise AlbumMigrationError("EmDash album readback mismatch")
        return content_id
    slug = str(album.get("slug") or "")
    existing = get_content_by_identifier("albums", slug, env=env, token=token)
    if existing is not None:
        existing_data = existing.get("data")
        expected_key = album.get("source", {}).get("album_key")
        if (
            not isinstance(existing.get("id"), str)
            or not isinstance(existing_data, dict)
            or existing_data.get("source_album_key") != expected_key
            or existing_data.get("source_metadata", {}).get("stable_album_id")
            != album.get("id")
        ):
            raise AlbumMigrationError(
                f"Existing EmDash album slug does not match frozen source: {slug}"
            )
        destination["emdash_content_id"] = existing["id"]
        checkpoint(manifest_path, manifest)
        return str(existing["id"])
    data = album_content_payload(album, manifest.get("assets", []))
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".json", delete=False
    ) as handle:
        json.dump(data, handle, ensure_ascii=False)
        payload_path = Path(handle.name)
    try:
        result: dict[str, Any] | None = None
        for attempt in range(1, 6):
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
                break
            except AlbumMigrationError as exc:
                existing = get_content_by_identifier(
                    "albums", slug, env=env, token=token
                )
                if existing is not None:
                    existing_data = existing.get("data")
                    if (
                        not isinstance(existing_data, dict)
                        or existing_data.get("source_album_key")
                        != data.get("source_album_key")
                        or existing_data.get("source_metadata", {}).get(
                            "stable_album_id"
                        )
                        != data.get("source_metadata", {}).get("stable_album_id")
                    ):
                        raise AlbumMigrationError(
                            "Recovered EmDash album does not match the attempted create"
                        ) from exc
                    result = existing
                    break
                if attempt == 5 or not is_transient_error(exc):
                    raise
                time.sleep(retry_delay(attempt))
    finally:
        payload_path.unlink(missing_ok=True)
    if result is None:
        raise AssertionError("unreachable")
    content_id = result.get("id")
    if not isinstance(content_id, str):
        raise AlbumMigrationError("EmDash album create omitted its id")
    destination["emdash_content_id"] = content_id
    checkpoint(manifest_path, manifest)
    return content_id


def reconcile_existing_asset(
    asset: dict[str, Any],
    existing: Mapping[str, Any],
    *,
    album_id: str,
    source_sha256: str,
) -> None:
    data = existing.get("data")
    source = asset.get("source", {})
    if (
        not isinstance(existing.get("id"), str)
        or not isinstance(data, dict)
        or data.get("source_system") != "smugmug"
        or data.get("source_id") != source.get("image_key")
        or data.get("original_sha256") != source_sha256
        or data.get("kind") != asset.get("kind")
        or data.get("album") != album_id
        or data.get("source_metadata", {}).get("stable_media_id") != asset.get("id")
    ):
        raise AlbumMigrationError(
            f"Existing EmDash photo slug does not match frozen source: {asset.get('id')}"
        )

    kind = str(asset.get("kind"))
    source_media = data.get("video") if kind == "video" else data.get("image")
    poster_media = data.get("image") if kind == "video" else None
    storage_key = (
        source_media.get("meta", {}).get("storageKey")
        if isinstance(source_media, dict)
        else None
    )
    if (
        not isinstance(source_media, dict)
        or not isinstance(source_media.get("id"), str)
        or not isinstance(storage_key, str)
    ):
        raise AlbumMigrationError("Existing EmDash photo has no source media reference")

    destination = asset.setdefault("destination", {})
    destination.update(
        {
            "emdash_content_id": existing["id"],
            "emdash_media_id": source_media["id"],
            "r2_object_key": storage_key,
            "media_path": public_media_path(storage_key),
        }
    )
    if kind == "video":
        poster_key = (
            poster_media.get("meta", {}).get("storageKey")
            if isinstance(poster_media, dict)
            else None
        )
        if (
            not isinstance(poster_media, dict)
            or not isinstance(poster_media.get("id"), str)
            or not isinstance(poster_key, str)
        ):
            raise AlbumMigrationError("Existing EmDash video has no poster media reference")
        destination["poster_media_id"] = poster_media["id"]
        destination["poster_r2_object_key"] = poster_key


def replace_asset_media(
    asset: dict[str, Any],
    source_file: Path,
    *,
    temp_root: Path,
    env: Mapping[str, str],
    token: str,
) -> None:
    """Repair a missing R2 object while preserving the existing content record."""
    destination = asset.setdefault("destination", {})
    content_id = destination.get("emdash_content_id")
    if not isinstance(content_id, str):
        raise AlbumMigrationError("Cannot repair media without an EmDash content id")
    alt = str(asset.get("display", {}).get("alt") or "")
    file_data = asset.get("file", {})
    source_media = upload_media(
        source_file,
        alt=alt,
        env=env,
        token=token,
        width=file_data.get("width") if isinstance(file_data.get("width"), int) else None,
        height=file_data.get("height") if isinstance(file_data.get("height"), int) else None,
    )
    poster_media: dict[str, Any] | None = None
    if asset.get("kind") == "video":
        poster = temp_root / "replacement-poster.jpg"
        make_video_poster(source_file, poster)
        poster_media = upload_media(poster, alt=alt, env=env, token=token)

    current = get_content_by_identifier(
        "photos", content_id, env=env, token=token
    )
    if current is None or not isinstance(current.get("_rev"), str):
        raise AlbumMigrationError("Existing EmDash photo has no revision for repair")
    update: dict[str, Any] = {
        "image": {
            "id": poster_media["id"] if poster_media else source_media["id"],
            "provider": "local",
            "alt": alt,
        }
    }
    if poster_media:
        update["video"] = {
            "id": source_media["id"],
            "provider": "local",
            "alt": alt,
        }
    run_emdash(
        [
            "content",
            "update",
            "photos",
            content_id,
            "--rev",
            str(current["_rev"]),
            "--data",
            json.dumps(update, ensure_ascii=False),
            "--draft",
        ],
        env,
        token=token,
    )
    destination.update(
        {
            "emdash_media_id": source_media["id"],
            "r2_object_key": source_media["storageKey"],
            "media_path": public_media_path(str(source_media["storageKey"])),
        }
    )
    if poster_media:
        destination["poster_media_id"] = poster_media["id"]
        destination["poster_r2_object_key"] = poster_media["storageKey"]


def preferred_cover_asset(manifest: Mapping[str, Any]) -> Mapping[str, Any] | None:
    assets = [
        asset
        for asset in manifest.get("assets", [])
        if asset.get("verification", {}).get("r2_roundtrip_verified")
        and asset.get("destination", {}).get("emdash_media_id")
    ]
    highlight_key = (
        manifest.get("album", {}).get("source", {}).get("highlight_image_key")
    )
    if highlight_key:
        highlighted = next(
            (
                asset
                for asset in assets
                if asset.get("source", {}).get("image_key") == highlight_key
            ),
            None,
        )
        if highlighted is not None:
            return highlighted
    return assets[0] if assets else None


def ensure_album_cover(
    manifest: dict[str, Any], *, env: Mapping[str, str], token: str
) -> bool:
    album_id = manifest.get("album", {}).get("destination", {}).get("emdash_content_id")
    if not isinstance(album_id, str):
        return False
    cover_asset = preferred_cover_asset(manifest)
    if cover_asset is None:
        return False
    destination = cover_asset.get("destination", {})
    cover_media_id = destination.get("poster_media_id") or destination.get(
        "emdash_media_id"
    )
    current = get_content_by_identifier(
        "albums", album_id, env=env, token=token
    )
    if current is None:
        raise AlbumMigrationError("EmDash album cover readback was not found")
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
                        "alt": str(cover_asset.get("display", {}).get("alt") or ""),
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
    for attempt in range(1, 6):
        digest = hashlib.sha256()
        size = 0
        request = Request(url, headers={"User-Agent": "kanouk-migration-verifier/1.0"})
        try:
            with urlopen(request, timeout=300) as response:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
            return digest.hexdigest(), size
        except (HTTPError, TimeoutError, URLError, OSError) as exc:
            if attempt == 5 or not is_transient_error(exc):
                raise
            time.sleep(retry_delay(attempt))
    raise AssertionError("unreachable")


def verify_existing_content(
    asset: Mapping[str, Any], *, env: Mapping[str, str], token: str
) -> None:
    content_id = asset.get("destination", {}).get("emdash_content_id")
    if not isinstance(content_id, str):
        raise AlbumMigrationError("Asset has no EmDash content id")
    payload = get_content_by_identifier(
        "photos", content_id, env=env, token=token
    )
    if payload is None:
        raise AlbumMigrationError("EmDash content readback was not found")
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
    client: SmugMugClient,
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
        destination = asset["destination"]
        storage_key = destination.get("r2_object_key")
        if isinstance(storage_key, str):
            expected_path = public_media_path(storage_key)
            if destination.get("media_path") != expected_path:
                destination["media_path"] = expected_path
                checkpoint(manifest_path, manifest)
        return "skipped_verified"
    expected_md5 = str(asset.get("source", {}).get("archived_md5") or "").lower()
    with tempfile.TemporaryDirectory(prefix="kanouk-smugmug-") as directory:
        temp_root = Path(directory)
        source_file = temp_root / f"source{source_extension(asset)}"
        hashes = download_source(live, expected_md5, source_file, client=client)
        metadata_uri = ((live.get("Uris") or {}).get("ImageMetadata") or {}).get(
            "Uri"
        )
        metadata_payload = client.get(metadata_uri) if metadata_uri else {}
        metadata = merge_owner_location(
            extract_metadata(source_file), live, metadata_payload
        )
        verification = asset.setdefault("verification", {})
        verification["source_md5_verified"] = bool(hashes["reported_md5_match"])
        verification["source_integrity_verified"] = bool(
            hashes["reported_md5_match"] or hashes["repeated_download_match"]
        )
        verification["sha256"] = hashes["sha256"]
        verification["source_integrity"] = {
            "download_method": hashes["download_method"],
            "owner_only": hashes["owner_only"],
            "smugmug_reported_md5": hashes["smugmug_reported_md5"],
            "smugmug_reported_bytes": hashes["smugmug_reported_bytes"],
            "downloaded_md5": hashes["md5"],
            "downloaded_bytes": hashes["bytes"],
            "reported_md5_match": hashes["reported_md5_match"],
            "repeated_download_match": hashes["repeated_download_match"],
        }

        destination = asset.setdefault("destination", {})
        if not destination.get("emdash_content_id"):
            existing = get_content_by_identifier(
                "photos", str(asset.get("id") or ""), env=env, token=token
            )
            if existing is not None:
                reconcile_existing_asset(
                    asset,
                    existing,
                    album_id=album_id,
                    source_sha256=str(hashes["sha256"]),
                )
                checkpoint(manifest_path, manifest)
        if not destination.get("emdash_content_id"):
            source_media = upload_media(
                source_file,
                alt=str(asset.get("display", {}).get("alt") or ""),
                env=env,
                token=token,
                width=(
                    asset.get("file", {}).get("width")
                    if isinstance(asset.get("file", {}).get("width"), int)
                    else None
                ),
                height=(
                    asset.get("file", {}).get("height")
                    if isinstance(asset.get("file", {}).get("height"), int)
                    else None
                ),
            )
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
            data = content_payload(
                asset,
                album_id=album_id,
                source_media_id=str(source_media["id"]),
                poster_media_id=str(poster_media["id"]) if poster_media else None,
                metadata=metadata,
                source_sha256=str(hashes["sha256"]),
                source_integrity=verification["source_integrity"],
            )
            content = create_content(asset, data, env=env, token=token)
            destination["emdash_content_id"] = content["id"]
            destination["emdash_media_id"] = source_media["id"]
            destination["r2_object_key"] = source_media["storageKey"]
            destination["media_path"] = public_media_path(str(source_media["storageKey"]))
            if poster_media:
                destination["poster_media_id"] = poster_media["id"]
                destination["poster_r2_object_key"] = poster_media["storageKey"]
            checkpoint(manifest_path, manifest)

        storage_key = destination.get("r2_object_key")
        if not isinstance(storage_key, str):
            raise AlbumMigrationError("Asset has no destination storage key")
        try:
            public_hash, public_bytes = public_sha256(storage_key)
        except HTTPError as exc:
            if exc.code != 404:
                raise
            replace_asset_media(
                asset,
                source_file,
                temp_root=temp_root,
                env=env,
                token=token,
            )
            checkpoint(manifest_path, manifest)
            storage_key = asset["destination"].get("r2_object_key")
            if not isinstance(storage_key, str):
                raise AlbumMigrationError("Repaired asset has no destination storage key")
            public_hash, public_bytes = public_sha256(storage_key)
        if public_hash != hashes["sha256"] or public_bytes != hashes["bytes"]:
            raise AlbumMigrationError("Worker media readback does not match source bytes")
        verification.pop("migration_status", None)
        verification.pop("owner_auth_reason", None)
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
    client = SmugMugClient(api_key)
    live_assets = find_live_assets(
        client,
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
        if not live.get("ArchivedMD5") or (
            not client.owner_authenticated and not live.get("ArchivedUri")
        ):
            verification = asset.setdefault("verification", {})
            verification["migration_status"] = "pending_owner_auth"
            verification["owner_auth_reason"] = "public_archive_unavailable"
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
                client=client,
                live=live,
                album_id=album_id,
                manifest_path=manifest_path,
                manifest=manifest,
                env=env,
                token=credential["token"],
            )
            counts[status] += 1
            print(f"[{index}/{len(assets)}] {asset['id']}: {status}", flush=True)
        except OwnerAuthenticationRequired as exc:
            verification = asset.setdefault("verification", {})
            verification["migration_status"] = "pending_owner_auth"
            verification["owner_auth_reason"] = "public_archive_hash_mismatch"
            counts["pending_owner_auth"] += 1
            checkpoint(manifest_path, manifest)
            print(
                f"[{index}/{len(assets)}] {asset.get('id')}: "
                f"pending_owner_auth: {exc}",
                flush=True,
            )
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
