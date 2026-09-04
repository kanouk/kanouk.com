#!/usr/bin/env python3
"""Remove location metadata from an explicit photo allowlist without re-encoding pixels.

Dry-run is the default. The apply path only uses EmDash HTTP APIs, retains the old
Media object, publishes only entries that were already public, and verifies CMS,
public HTML, and embedded GPS readback before reporting success.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen


SCRIPT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_ROOT.parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts/cloudflare"))

from run_emdash_kanouk import EXPECTED_URL, child_environment, load_credential, preflight


LOCATION_KEYS = {
    "gps", "gpslatitude", "gpslongitude", "gpsaltitude",
    "latitude", "longitude", "altitude", "location", "geotag",
}


class RedactionError(RuntimeError):
    pass


def normalized_key(value: str) -> str:
    return re.sub(r"[^a-z]", "", value.lower())


def scrub_location(value: Any) -> Any:
    if isinstance(value, list):
        return [scrub_location(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key: scrub_location(child)
        for key, child in value.items()
        if normalized_key(str(key)) not in LOCATION_KEYS
    }


def load_allowlist(path: Path) -> list[str]:
    payload = json.loads(path.read_text())
    values = payload.get("photo_ids") if isinstance(payload, dict) else None
    if not isinstance(values, list) or not values:
        raise RedactionError("allowlist must contain a non-empty photo_ids array")
    result: list[str] = []
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value):
            raise RedactionError("allowlist contains an invalid photo id")
        if value not in result:
            result.append(value)
    return result


def api_request(
    method: str,
    path: str,
    token: str,
    payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    request = Request(
        EXPECTED_URL + "/_emdash/api" + path,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
            "User-Agent": "kanouk-location-redaction/1.0",
        },
    )
    try:
        with urlopen(request, timeout=180) as response:
            result = json.load(response)
    except HTTPError as exc:
        detail = exc.read(500).decode(errors="replace")
        raise RedactionError(f"EmDash HTTP {exc.code}: {detail}") from exc
    if not isinstance(result, dict):
        raise RedactionError("EmDash returned a non-object response")
    data = result.get("data", result)
    if not isinstance(data, dict):
        raise RedactionError("EmDash returned an invalid response envelope")
    return data


def photo_record(photo_id: str, token: str) -> tuple[dict[str, Any], str]:
    result = api_request("GET", f"/content/photos/{quote(photo_id, safe='')}?locale=ja", token)
    item, revision = result.get("item"), result.get("_rev")
    if not isinstance(item, dict) or not isinstance(revision, str):
        raise RedactionError(f"photo readback is invalid: {photo_id}")
    return item, revision


def download(url: str, token: str, destination: Path) -> None:
    request = Request(
        urljoin(EXPECTED_URL, url),
        headers={"Authorization": f"Bearer {token}", "User-Agent": "kanouk-location-redaction/1.0"},
    )
    with urlopen(request, timeout=300) as response:
        destination.write_bytes(response.read())


def exif_snapshot(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["exiftool", "-j", "-ImageDataHash", "-GPS:all", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RedactionError("exiftool inspection failed")
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        raise RedactionError("exiftool returned invalid JSON")
    return rows[0]


def image_data_hash(snapshot: Mapping[str, Any]) -> str:
    value = snapshot.get("ImageDataHash")
    if not isinstance(value, str) or not value:
        raise RedactionError("ImageDataHash is unavailable; refusing an unverifiable rewrite")
    return value


def has_embedded_location(snapshot: Mapping[str, Any]) -> bool:
    return any(
        normalized_key(str(key)) in LOCATION_KEYS or normalized_key(str(key)).startswith("gps")
        for key in snapshot
        if key not in {"SourceFile", "ImageDataHash"}
    )


def strip_location(source: Path, output: Path) -> str:
    shutil.copy2(source, output)
    before = exif_snapshot(source)
    result = subprocess.run(
        ["exiftool", "-overwrite_original", "-GPS:all=", "-XMP:Geotag=", str(output)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RedactionError("exiftool location removal failed")
    after = exif_snapshot(output)
    before_hash = image_data_hash(before)
    if image_data_hash(after) != before_hash:
        raise RedactionError("pixel data changed; refusing to continue")
    if has_embedded_location(after):
        raise RedactionError("embedded GPS remains after redaction")
    return before_hash


def multipart_upload(path: Path, token: str, alt: str) -> dict[str, Any]:
    boundary = "----kanouk-" + uuid.uuid4().hex
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    chunks = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"alt\"\r\n\r\n{alt}\r\n".encode(),
        (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{path.name.replace(chr(34), '')}\"\r\nContent-Type: {mime}\r\n\r\n"
        ).encode(),
        path.read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    request = Request(
        EXPECTED_URL + "/_emdash/api/media",
        data=b"".join(chunks),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "kanouk-location-redaction/1.0",
        },
    )
    with urlopen(request, timeout=300) as response:
        result = json.load(response)
    item = result.get("data", {}).get("item") if isinstance(result, dict) else None
    if not isinstance(item, dict) or not isinstance(item.get("id"), str):
        raise RedactionError("media upload returned an invalid item")
    return item


def media_value(item: Mapping[str, Any], alt: str) -> dict[str, Any]:
    return {
        key: value
        for key, value in {
            "id": item.get("id"),
            "src": item.get("url"),
            "filename": item.get("filename"),
            "mimeType": item.get("mimeType"),
            "width": item.get("width"),
            "height": item.get("height"),
            "blurhash": item.get("blurhash"),
            "dominantColor": item.get("dominantColor"),
            "alt": alt,
            "meta": {"storageKey": item.get("storageKey")} if item.get("storageKey") else None,
        }.items()
        if value is not None
    }


def verify_public(item: Mapping[str, Any], new_media: Mapping[str, Any], token: str, old_coordinates: Sequence[Any]) -> None:
    data = item.get("data", {})
    if any(data.get(key) is not None for key in ("latitude", "longitude", "altitude")):
        raise RedactionError("CMS coordinate readback is not empty")
    if scrub_location(data.get("source_metadata")) != data.get("source_metadata"):
        raise RedactionError("CMS source metadata still contains location fields")
    storage_key = new_media.get("storageKey")
    if not isinstance(storage_key, str):
        raise RedactionError("new media has no storage key")
    with tempfile.TemporaryDirectory(prefix="kanouk-location-public-") as directory:
        path = Path(directory) / "public-media"
        download(f"/_emdash/api/media/file/{quote(storage_key, safe='')}", token, path)
        if has_embedded_location(exif_snapshot(path)):
            raise RedactionError("public media still contains embedded GPS")
    slug = item.get("slug")
    if isinstance(slug, str) and slug:
        with urlopen(f"https://photos.kanouk.com/p/{quote(slug, safe='')}", timeout=60) as response:
            html = response.read().decode(errors="replace")
        for coordinate in old_coordinates:
            if isinstance(coordinate, (int, float)) and str(coordinate) in html:
                raise RedactionError("public page still exposes a removed coordinate")


def redact_one(photo_id: str, token: str, apply: bool) -> dict[str, Any]:
    item, revision = photo_record(photo_id, token)
    data = item.get("data")
    if not isinstance(data, dict):
        raise RedactionError(f"photo data is invalid: {photo_id}")
    image = data.get("image")
    if not isinstance(image, dict):
        raise RedactionError(f"photo image is missing: {photo_id}")
    source_url = image.get("src") or image.get("url")
    if not isinstance(source_url, str):
        storage_key = image.get("meta", {}).get("storageKey") if isinstance(image.get("meta"), dict) else None
        source_url = f"/_emdash/api/media/file/{quote(storage_key, safe='')}" if isinstance(storage_key, str) else ""
    if not source_url:
        raise RedactionError(f"photo source URL is missing: {photo_id}")
    old_coordinates = [data.get("latitude"), data.get("longitude"), data.get("altitude")]
    if not apply:
        return {"photo_id": photo_id, "action": "would-redact", "was_published": item.get("status") == "published"}
    with tempfile.TemporaryDirectory(prefix="kanouk-location-redact-") as directory:
        source = Path(directory) / (str(image.get("filename") or photo_id) + ".source")
        output = Path(directory) / str(image.get("filename") or f"{photo_id}.jpg")
        download(source_url, token, source)
        strip_location(source, output)
        uploaded = multipart_upload(output, token, str(data.get("alt") or ""))
    updated_metadata = scrub_location(data.get("source_metadata"))
    patch = {
        "image": media_value(uploaded, str(data.get("alt") or "")),
        "latitude": None,
        "longitude": None,
        "altitude": None,
        "source_metadata": updated_metadata,
    }
    api_request("PUT", f"/content/photos/{quote(photo_id, safe='')}?locale=ja", token, {"data": patch, "_rev": revision})
    if item.get("status") == "published":
        api_request("POST", f"/content/photos/{quote(photo_id, safe='')}/publish?locale=ja", token, {})
    readback, _ = photo_record(photo_id, token)
    verify_public(readback, uploaded, token, old_coordinates)
    return {"photo_id": photo_id, "action": "redacted", "media_id": uploaded["id"], "old_media_retained": True}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allowlist", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    photo_ids = load_allowlist(args.allowlist)
    credential = load_credential()
    preflight(child_environment(credential))
    results, failures = [], []
    for photo_id in photo_ids:
        try:
            results.append(redact_one(photo_id, credential["token"], args.apply))
        except Exception as exc:
            failures.append({"photo_id": photo_id, "reason": str(exc)})
    if args.apply:
        try:
            api_request("POST", "/plugins/yohaku-photo-studio/operations", credential["token"], {
                "action": "record", "kind": "location-redaction",
                "status": "partial" if failures else "complete",
                "targetIds": photo_ids, "failures": failures,
                "metadata": {"succeeded": len(results), "explicit_allowlist": True, "old_media_retained": True},
            })
        except Exception as exc:
            failures.append({"photo_id": "operation-receipt", "reason": str(exc)})
    print(json.dumps({"apply": args.apply, "requested": len(photo_ids), "results": results, "failures": failures}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
