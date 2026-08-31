#!/usr/bin/env python3
"""Upload one GPS-preserving pilot image and attach its location to EmDash."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, Mapping, Sequence


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

from run_emdash_kanouk import (  # noqa: E402
    EXPECTED_URL,
    WEB_ROOT,
    child_environment,
    load_credential,
    preflight,
)


class PilotGpsError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def validated_location(row: Mapping[str, Any]) -> dict[str, float | None]:
    latitude = row.get("GPSLatitude")
    longitude = row.get("GPSLongitude")
    altitude = row.get("GPSAltitude")
    if not isinstance(latitude, (int, float)) or not -90 <= float(latitude) <= 90:
        raise PilotGpsError("Source image has no valid GPS latitude")
    if not isinstance(longitude, (int, float)) or not -180 <= float(longitude) <= 180:
        raise PilotGpsError("Source image has no valid GPS longitude")
    if altitude is not None and not isinstance(altitude, (int, float)):
        raise PilotGpsError("Source image has an invalid GPS altitude")
    return {
        "latitude": float(latitude),
        "longitude": float(longitude),
        "altitude": float(altitude) if altitude is not None else None,
    }


def extract_location(path: Path) -> dict[str, float | None]:
    result = subprocess.run(
        [
            "exiftool",
            "-n",
            "-j",
            "-GPSLatitude",
            "-GPSLongitude",
            "-GPSAltitude",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise PilotGpsError("Could not read GPS EXIF from source image")
    rows = json.loads(result.stdout)
    return validated_location(rows[0] if rows else {})


def content_patch(
    existing_data: Mapping[str, Any],
    *,
    media_id: str,
    location: Mapping[str, float | None],
    source_sha256: str,
) -> dict[str, Any]:
    source_metadata = existing_data.get("source_metadata")
    if not isinstance(source_metadata, dict):
        source_metadata = {}
    source_metadata = {
        **source_metadata,
        "gps_exif_preserved": True,
        "gps_coordinates_stored": "emdash-fields",
        "public_metadata_policy": "Source GPS EXIF retained",
    }
    patch: dict[str, Any] = {
        "image": {
            "id": media_id,
            "provider": "local",
            "alt": existing_data.get("alt") or existing_data.get("title") or "",
        },
        "latitude": location["latitude"],
        "longitude": location["longitude"],
        "original_sha256": source_sha256,
        "source_metadata": source_metadata,
    }
    if location.get("altitude") is not None:
        patch["altitude"] = location["altitude"]
    return patch


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
        raise PilotGpsError(
            f"EmDash command failed ({result.returncode}): {detail[:400] or 'no diagnostic output'}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PilotGpsError("EmDash returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise PilotGpsError("EmDash returned an unexpected response")
    return payload


def apply(
    *, source_file: Path, content_id: str, expected_sha256: str
) -> dict[str, Any]:
    actual_sha256 = sha256_file(source_file)
    if actual_sha256 != expected_sha256:
        raise PilotGpsError("Source SHA-256 does not match the expected manifest value")
    location = extract_location(source_file)
    credential = load_credential()
    env = child_environment(credential)
    preflight(env)

    existing = run_emdash(
        ["content", "get", "photos", content_id, "--raw"],
        env,
        token=credential["token"],
    )
    existing_data = existing.get("data")
    revision = existing.get("_rev")
    if not isinstance(existing_data, dict) or not isinstance(revision, str):
        raise PilotGpsError("EmDash photo response has no writable revision")
    previous_image = existing_data.get("image")
    previous_media_id = (
        previous_image.get("id") if isinstance(previous_image, dict) else None
    )

    media = run_emdash(
        [
            "media",
            "upload",
            str(source_file),
            "--alt",
            str(existing_data.get("alt") or existing_data.get("title") or ""),
        ],
        env,
        token=credential["token"],
    )
    media_id = media.get("id")
    if not isinstance(media_id, str):
        raise PilotGpsError("EmDash upload response has no media id")

    patch = content_patch(
        existing_data,
        media_id=media_id,
        location=location,
        source_sha256=actual_sha256,
    )
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".json", delete=False
        ) as handle:
            json.dump(patch, handle, ensure_ascii=False)
            payload_path = Path(handle.name)
        updated = run_emdash(
            [
                "content",
                "update",
                "photos",
                content_id,
                "--rev",
                revision,
                "--file",
                str(payload_path),
            ],
            env,
            token=credential["token"],
        )
    except Exception:
        run_emdash(
            ["media", "delete", media_id], env, token=credential["token"]
        )
        raise
    finally:
        if "payload_path" in locals():
            payload_path.unlink(missing_ok=True)

    updated_data = updated.get("data")
    if not isinstance(updated_data, dict):
        raise PilotGpsError("Updated EmDash photo has no data")
    if updated_data.get("latitude") != location["latitude"] or updated_data.get(
        "longitude"
    ) != location["longitude"]:
        raise PilotGpsError("EmDash did not retain the GPS fields")
    updated_image = updated_data.get("image")
    if not isinstance(updated_image, dict) or updated_image.get("id") != media_id:
        raise PilotGpsError("EmDash did not attach the uploaded GPS image")

    return {
        "applied": True,
        "content_id": content_id,
        "gps_present": True,
        "altitude_present": location.get("altitude") is not None,
        "source_sha256": actual_sha256,
        "new_media_id": media_id,
        "new_storage_key": media.get("storageKey"),
        "previous_media_id": previous_media_id,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--file", required=True)
    result.add_argument("--content-id", required=True)
    result.add_argument("--expected-sha256", required=True)
    result.add_argument("--apply", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    source_file = Path(args.file)
    location = extract_location(source_file)
    source_sha256 = sha256_file(source_file)
    if source_sha256 != args.expected_sha256:
        raise SystemExit("Source SHA-256 does not match the expected manifest value")
    if not args.apply:
        print(
            json.dumps(
                {
                    "applied": False,
                    "gps_present": True,
                    "altitude_present": location.get("altitude") is not None,
                    "source_sha256": source_sha256,
                }
            )
        )
        return
    try:
        print(
            json.dumps(
                apply(
                    source_file=source_file,
                    content_id=args.content_id,
                    expected_sha256=args.expected_sha256,
                )
            )
        )
    except PilotGpsError as exc:
        raise SystemExit(f"GPS pilot update failed: {exc}") from exc


if __name__ == "__main__":
    main()
