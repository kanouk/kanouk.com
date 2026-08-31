#!/usr/bin/env python3
"""Import every WordPress WXR attachment into EmDash with byte verification.

The importer uses EmDash's guarded WordPress media endpoint so uploads retain
its content-hash deduplication and image enrichment.  A local runtime ledger is
checkpointed after every attachment.  An item is only marked ``verified`` when
the original WordPress URL and the EmDash public media URL have identical
SHA-256 hashes.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

from run_emdash_kanouk import EXPECTED_EMAIL, EXPECTED_URL, EmDashGuardError, preflight  # noqa: E402
from run_wordpress_import_kanouk import CREDENTIAL_FILE, field  # noqa: E402


SOURCES = (
    (
        "kanolog",
        Path("/Users/kanouk/Documents/Private_External_Imports/blog/wordpress.2026-07-10.xml"),
    ),
    (
        "nocalog",
        Path("/Users/kanouk/Documents/Private_External_Imports/blog/nocalog-noca.WordPress.2026-07-10.xml"),
    ),
    (
        "art-quiz",
        Path("/Users/kanouk/Documents/Private_External_Imports/blog/11.WordPress.2026-07-10.xml"),
    ),
)
DEFAULT_LEDGER = REPO_ROOT / "migration/wordpress/runtime/media-ledger.json"
WP = "http://wordpress.org/export/1.2/"
CONTENT = "http://purl.org/rss/1.0/modules/content/"
EXCERPT = "http://wordpress.org/export/1.2/excerpt/"
TRANSIENT_STATUSES = {429, 502, 503, 504}
MEDIA_FILENAME = re.compile(
    r"(?:^|[/\"'])([^/\"']+\.(?:avif|gif|jpe?g|png|webp|svg|pdf|xlsx?|docx?|mp3|m4a|mp4|mov|webm|zip))",
    re.IGNORECASE,
)


class MediaMigrationError(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def text(element: ET.Element, name: str, default: str = "") -> str:
    child = element.find(name)
    return (child.text or default).strip() if child is not None else default


def attachment_aliases(url: str, guid: str, metadata: dict[str, str]) -> list[str]:
    aliases = {candidate for candidate in (url, guid) if candidate.startswith(("http://", "https://"))}
    parsed = urlparse(url)
    base = url.rsplit("/", 1)[0] + "/"
    upload_root_match = re.match(r"^(.*?/wp-content/uploads/)", url)
    upload_root = upload_root_match.group(1) if upload_root_match else ""
    for value in metadata.values():
        for match in MEDIA_FILENAME.finditer(value):
            filename = match.group(1)
            if "/" in filename and upload_root:
                aliases.add(urljoin(upload_root, filename))
            else:
                aliases.add(urljoin(base, filename))
    if parsed.query:
        aliases.add(url.split("?", 1)[0])
    return sorted(aliases)


def parse_wxr_attachments(site: str, source: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for _event, item in ET.iterparse(source, events=("end",)):
        if item.tag != "item":
            continue
        if text(item, f"{{{WP}}}post_type") != "attachment":
            item.clear()
            continue
        source_id = text(item, f"{{{WP}}}post_id")
        url = text(item, f"{{{WP}}}attachment_url")
        metadata: dict[str, str] = {}
        for postmeta in item.findall(f"{{{WP}}}postmeta"):
            key = text(postmeta, f"{{{WP}}}meta_key")
            if key:
                metadata[key] = text(postmeta, f"{{{WP}}}meta_value")
        guid = text(item, "guid")
        path_name = unquote(urlparse(url).path)
        filename = Path(path_name).name or f"wordpress-{site}-{source_id}"
        mime_type = text(item, f"{{{WP}}}post_mime_type") or mimetypes.guess_type(filename)[0]
        result.append(
            {
                "key": f"{site}:{source_id}",
                "site": site,
                "source_id": source_id,
                "url": url,
                "aliases": attachment_aliases(url, guid, metadata),
                "filename": filename,
                "mime_type": mime_type or "application/octet-stream",
                "title": text(item, "title"),
                "alt": metadata.get("_wp_attachment_image_alt", ""),
                "caption": text(item, f"{{{EXCERPT}}}encoded"),
                "description": text(item, f"{{{CONTENT}}}encoded"),
                "parent_id": text(item, f"{{{WP}}}post_parent"),
                "post_date": text(item, f"{{{WP}}}post_date"),
                "post_date_gmt": text(item, f"{{{WP}}}post_date_gmt"),
                "source_metadata": metadata,
            }
        )
        item.clear()
    return result


def build_catalog(sources: Iterable[tuple[str, Path]] = SOURCES) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    assets: list[dict[str, Any]] = []
    source_rows: list[dict[str, str]] = []
    for site, source in sources:
        raw = source.read_bytes()
        source_rows.append({"site": site, "path": str(source), "sha256": hashlib.sha256(raw).hexdigest()})
        assets.extend(parse_wxr_attachments(site, source))
    return assets, source_rows


def load_admin_credential() -> tuple[str, dict[str, str]]:
    content = CREDENTIAL_FILE.read_text()
    email = field(content, "Admin Email")
    url = field(content, "URL")
    scopes = field(content, "Scopes")
    status = field(content, "Status")
    token = field(content, "Token")
    if email != EXPECTED_EMAIL or url != EXPECTED_URL:
        raise EmDashGuardError("Temporary credential does not match pinned owner/origin")
    if scopes != "admin" or status != "active" or not token.startswith("ec_pat_"):
        raise EmDashGuardError("Temporary credential is not an active admin token")
    env = dict(os.environ)
    env["EMDASH_URL"] = EXPECTED_URL
    env["EMDASH_TOKEN"] = token
    preflight(env)
    return token, env


def should_retry(status: int | None, error: Exception | None = None) -> bool:
    return status in TRANSIENT_STATUSES or isinstance(error, (TimeoutError, URLError))


def request_json(path: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode()
    for attempt in range(1, 6):
        request = Request(
            EXPECTED_URL + path,
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "kanouk-wordpress-media-migration/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=120) as response:
                parsed = json.loads(response.read())
                if not isinstance(parsed, dict):
                    raise MediaMigrationError("EmDash returned a non-object response")
                return parsed
        except HTTPError as exc:
            if attempt < 5 and should_retry(exc.code):
                time.sleep(min(0.5 * 2 ** (attempt - 1), 8))
                continue
            detail = exc.read(500).decode(errors="replace")
            raise MediaMigrationError(f"EmDash HTTP {exc.code}: {detail}") from exc
        except (TimeoutError, URLError) as exc:
            if attempt < 5 and should_retry(None, exc):
                time.sleep(min(0.5 * 2 ** (attempt - 1), 8))
                continue
            raise MediaMigrationError(f"EmDash request failed: {exc}") from exc
    raise MediaMigrationError("EmDash retry loop exhausted")


def remote_sha256(url: str, token: str | None = None) -> tuple[str, int, str]:
    headers = {"User-Agent": "kanouk-wordpress-media-migration/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    digest = hashlib.sha256()
    size = 0
    with urlopen(request, timeout=300) as response:
        content_type = response.headers.get_content_type()
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size, content_type


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def migrate_one(asset: dict[str, Any], token: str) -> dict[str, Any]:
    response = request_json(
        "/_emdash/api/import/wordpress/media",
        token,
        {
            "attachments": [
                {
                    "id": int(asset["source_id"]),
                    "title": asset["title"],
                    "url": asset["url"],
                    "filename": asset["filename"],
                    "mimeType": asset["mime_type"],
                }
            ],
            "stream": False,
        },
    )
    data = response.get("data", response)
    imported = data.get("imported", []) if isinstance(data, dict) else []
    failed = data.get("failed", []) if isinstance(data, dict) else []
    if failed or len(imported) != 1:
        reason = failed[0].get("error", "unknown import failure") if failed else "missing import result"
        raise MediaMigrationError(str(reason))
    item = imported[0]
    destination = urljoin(EXPECTED_URL, item["newUrl"])
    source_hash, source_size, source_type = remote_sha256(asset["url"])
    destination_hash, destination_size, destination_type = remote_sha256(destination, token)
    if source_hash != destination_hash or source_size != destination_size:
        raise MediaMigrationError("source and destination bytes do not match")
    return {
        "status": "verified",
        "verified_at": now_iso(),
        "media_id": item["mediaId"],
        "public_path": item["newUrl"],
        "sha256": source_hash,
        "byte_size": source_size,
        "source_content_type": source_type,
        "destination_content_type": destination_type,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--site", choices=[site for site, _path in SOURCES])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--reverify", action="store_true")
    args = parser.parse_args(argv)
    assets, source_rows = build_catalog()
    total_available = len(assets)
    if args.site:
        assets = [asset for asset in assets if asset["site"] == args.site]
    if args.limit:
        assets = assets[: args.limit]
    existing: dict[str, Any] = {}
    if args.ledger.exists():
        existing = json.loads(args.ledger.read_text())
    items = existing.get("items", {}) if isinstance(existing.get("items", {}), dict) else {}
    ledger = {
        "version": 1,
        "generated_at": now_iso(),
        "source_files": source_rows,
        "total_available": total_available,
        "selected": len(assets),
        "items": items,
    }
    print(json.dumps({"apply": args.apply, "selected": len(assets), "ledger": str(args.ledger)}))
    if not args.apply:
        return 0
    token, _env = load_admin_credential()
    failures = 0
    for index, asset in enumerate(assets, start=1):
        previous = items.get(asset["key"], {})
        if previous.get("status") == "verified" and not args.reverify:
            print(f"[{index}/{len(assets)}] {asset['key']} skipped_verified")
            continue
        try:
            migrated = migrate_one(asset, token)
            items[asset["key"]] = {**asset, **migrated}
            print(f"[{index}/{len(assets)}] {asset['key']} verified")
        except Exception as exc:  # checkpoint the source identity and diagnostic
            failures += 1
            items[asset["key"]] = {
                **asset,
                "status": "failed",
                "failed_at": now_iso(),
                "error": str(exc)[:500],
            }
            print(f"[{index}/{len(assets)}] {asset['key']} failed: {exc}", file=sys.stderr)
            if not args.continue_on_error:
                ledger["generated_at"] = now_iso()
                write_json_atomic(args.ledger, ledger)
                return 1
        ledger["generated_at"] = now_iso()
        write_json_atomic(args.ledger, ledger)
    statuses: dict[str, int] = {}
    for value in items.values():
        status = str(value.get("status", "unknown"))
        statuses[status] = statuses.get(status, 0) + 1
    ledger["counts"] = statuses
    write_json_atomic(args.ledger, ledger)
    print(json.dumps({"selected": len(assets), "counts": statuses, "failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
