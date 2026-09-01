#!/usr/bin/env python3
"""Create a verified D1 + R2-byte backup of the pinned kanouk staging stack."""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

from run_emdash_kanouk import (  # noqa: E402
    EXPECTED_URL,
    child_environment as emdash_environment,
    load_credential as load_emdash_credential,
    preflight as emdash_preflight,
)
from run_wrangler_kanouk import (  # noqa: E402
    WEB_ROOT,
    WRANGLER_BIN,
    child_environment as cloudflare_environment,
    load_credential as load_cloudflare_credential,
    preflight as cloudflare_preflight,
)


DEFAULT_BACKUP_ROOT = Path(
    "/Users/kanouk/Documents/Private_External_Imports/kanouk-cloudflare-backups"
)
DATABASE_NAME = "kanouk-content-staging"
STORAGE_KEY = re.compile(r"^[A-Za-z0-9._-]+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", dir=path.parent, delete=False, encoding="utf-8"
    ) as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")
        temporary = Path(output.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def list_media(token: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        query: dict[str, str | int] = {"limit": 100}
        if cursor:
            query["cursor"] = cursor
        request = Request(
            f"{EXPECTED_URL}/_emdash/api/media?{urlencode(query)}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "kanouk-backup/1.0",
            },
        )
        with urlopen(request, timeout=120) as response:
            payload = json.load(response)
        page = payload.get("data", payload)
        if not isinstance(page, dict) or not isinstance(page.get("items"), list):
            raise RuntimeError("EmDash media listing returned an invalid response")
        items.extend(item for item in page["items"] if isinstance(item, dict))
        cursor = page.get("nextCursor")
        if not isinstance(cursor, str) or not cursor:
            return items


def download_media(item: dict[str, Any], output_root: Path, token: str) -> dict[str, Any]:
    storage_key = item.get("storageKey")
    if not isinstance(storage_key, str) or not STORAGE_KEY.fullmatch(storage_key):
        raise RuntimeError("Media item has an unsafe storage key")
    destination = output_root / "objects" / storage_key
    destination.parent.mkdir(parents=True, exist_ok=True)
    sha1 = hashlib.sha1()
    sha256 = hashlib.sha256()
    size = 0
    request = Request(
        f"{EXPECTED_URL}/_emdash/api/media/file/{quote(storage_key, safe='')}",
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "kanouk-backup/1.0",
        },
    )
    with tempfile.NamedTemporaryFile("wb", dir=destination.parent, delete=False) as output:
        temporary = Path(output.name)
        with urlopen(request, timeout=300) as response:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                sha1.update(chunk)
                sha256.update(chunk)
                size += len(chunk)
    expected_size = item.get("size")
    expected_hash = str(item.get("contentHash") or "")
    if size != expected_size or expected_hash != f"sha1:{sha1.hexdigest()}":
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Media backup verification failed: {item.get('id')}")
    temporary.chmod(0o600)
    temporary.replace(destination)
    return {
        "id": item.get("id"),
        "filename": item.get("filename"),
        "mime_type": item.get("mimeType"),
        "storage_key": storage_key,
        "relative_path": str(destination.relative_to(output_root)),
        "bytes": size,
        "sha1": sha1.hexdigest(),
        "sha256": sha256.hexdigest(),
        "status": item.get("status"),
    }


def export_d1(destination: Path) -> None:
    credential = load_cloudflare_credential()
    env = cloudflare_environment(credential)
    cloudflare_preflight(credential, env)
    result = subprocess.run(
        [
            str(WRANGLER_BIN),
            "d1",
            "export",
            DATABASE_NAME,
            "--remote",
            "--skip-confirmation",
            "--output",
            str(destination),
            "--config",
            str(WEB_ROOT / "wrangler.jsonc"),
        ],
        cwd=WEB_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not destination.is_file():
        raise RuntimeError("Cloudflare D1 export failed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_BACKUP_ROOT)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.concurrency < 1 or args.concurrency > 8:
        raise SystemExit("--concurrency must be between 1 and 8")
    credential = load_emdash_credential()
    env = emdash_environment(credential)
    emdash_preflight(env)
    media = list_media(credential["token"])
    if not args.apply:
        print(
            json.dumps(
                {
                    "apply": False,
                    "media_count": len(media),
                    "total_bytes": sum(int(item.get("size") or 0) for item in media),
                }
            )
        )
        return

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_root = args.output_root / timestamp
    output_root.mkdir(parents=True, exist_ok=False)
    d1_path = output_root / "d1.sql"
    export_d1(d1_path)
    entries: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures: dict[Future[dict[str, Any]], str] = {
            executor.submit(download_media, item, output_root, credential["token"]): str(
                item.get("id")
            )
            for item in media
        }
        for index, future in enumerate(as_completed(futures), 1):
            entries.append(future.result())
            if index % 25 == 0 or index == len(futures):
                print(f"[{index}/{len(futures)}] media verified", flush=True)
    entries.sort(key=lambda item: str(item["storage_key"]))
    d1_bytes = d1_path.read_bytes()
    manifest = {
        "backup_version": 1,
        "generated_at": now_iso(),
        "source": EXPECTED_URL,
        "database": DATABASE_NAME,
        "d1": {
            "relative_path": "d1.sql",
            "bytes": len(d1_bytes),
            "sha256": hashlib.sha256(d1_bytes).hexdigest(),
        },
        "media_count": len(entries),
        "media_total_bytes": sum(int(item["bytes"]) for item in entries),
        "media": entries,
    }
    write_json_atomic(output_root / "manifest.json", manifest)
    print(
        json.dumps(
            {
                "apply": True,
                "output": str(output_root),
                "media_count": len(entries),
                "media_total_bytes": manifest["media_total_bytes"],
                "d1_sha256": manifest["d1"]["sha256"],
            }
        )
    )


if __name__ == "__main__":
    main()
