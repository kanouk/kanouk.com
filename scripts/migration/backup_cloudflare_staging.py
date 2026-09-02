#!/usr/bin/env python3
"""Create a verified D1 + R2-byte backup of the pinned kanouk staging stack."""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
import time
from typing import Any
from urllib.error import HTTPError, URLError
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
    child_environment as cloudflare_environment,
    load_credential as load_cloudflare_credential,
    preflight as cloudflare_preflight,
)


DEFAULT_BACKUP_ROOT = Path(
    "/Users/kanouk/Documents/Private_External_Imports/kanouk-cloudflare-backups"
)
DATABASE_NAME = "kanouk-content-staging"
DATABASE_ID = "30d6fc05-588e-4c4c-9e96-2b77fe35dd82"
R2_BUCKET_NAME = "kanouk-public-media-staging"
STORAGE_KEY = re.compile(r"^[A-Za-z0-9._-]+$")
FTS_VIRTUAL_TABLE = re.compile(r"^_emdash_fts_[A-Za-z0-9_]+$")
FTS_SHADOW_TABLE = re.compile(
    r"^_emdash_fts_[A-Za-z0-9_]+_(?:config|content|data|docsize|idx)$"
)
D1_PAGE_SIZE = 50
PROTECTED_D1_TABLES = {"_cf_KV"}


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


def list_r2_objects(account_id: str, token: str) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        query: dict[str, str | int] = {"per_page": 1000}
        if cursor:
            query["cursor"] = cursor
        request = Request(
            (
                "https://api.cloudflare.com/client/v4/accounts/"
                f"{account_id}/r2/buckets/{R2_BUCKET_NAME}/objects?"
                f"{urlencode(query)}"
            ),
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "kanouk-backup/2.0",
            },
        )
        with urlopen(request, timeout=120) as response:
            payload = json.load(response)
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise RuntimeError("Cloudflare R2 listing was unsuccessful")
        page = payload.get("result") or []
        if not isinstance(page, list):
            raise RuntimeError("Cloudflare R2 listing returned invalid objects")
        objects.extend(item for item in page if isinstance(item, dict))
        result_info = payload.get("result_info") or {}
        cursor = result_info.get("cursor")
        if not result_info.get("is_truncated") or not isinstance(cursor, str):
            return objects


def storage_destination(output_root: Path, storage_key: str) -> Path:
    key_path = PurePosixPath(storage_key)
    if (
        key_path.is_absolute()
        or not key_path.parts
        or any(part in {"", ".", ".."} for part in key_path.parts)
    ):
        raise RuntimeError("R2 object has an unsafe storage key")
    return output_root / "objects" / Path(*key_path.parts)


def hash_file(path: Path) -> tuple[str, str, int]:
    sha1 = hashlib.sha1()
    sha256 = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            sha1.update(chunk)
            sha256.update(chunk)
            size += len(chunk)
    return sha1.hexdigest(), sha256.hexdigest(), size


def download_once(url: str, destination_parent: Path, token: str) -> tuple[Path, str, str, int]:
    sha1 = hashlib.sha1()
    sha256 = hashlib.sha256()
    size = 0
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "kanouk-backup/1.0",
        },
    )
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "wb", dir=destination_parent, delete=False
        ) as output:
            temporary = Path(output.name)
            with urlopen(request, timeout=300) as response:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    sha1.update(chunk)
                    sha256.update(chunk)
                    size += len(chunk)
        return temporary, sha1.hexdigest(), sha256.hexdigest(), size
    except Exception:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise


def media_entry(
    item: dict[str, Any],
    destination: Path,
    output_root: Path,
    sha1: str,
    sha256: str,
    size: int,
    verification: str,
) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "filename": item.get("filename"),
        "mime_type": item.get("mimeType"),
        "storage_key": item.get("storageKey"),
        "relative_path": str(destination.relative_to(output_root)),
        "bytes": size,
        "sha1": sha1,
        "sha256": sha256,
        "verification": verification,
        "status": item.get("status"),
        "tracking": "emdash",
    }


def download_media(item: dict[str, Any], output_root: Path, token: str) -> dict[str, Any]:
    storage_key = item.get("storageKey")
    if not isinstance(storage_key, str) or not STORAGE_KEY.fullmatch(storage_key):
        raise RuntimeError("Media item has an unsafe storage key")
    destination = storage_destination(output_root, storage_key)
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected_size = item.get("size")
    if not isinstance(expected_size, int) or expected_size < 0:
        raise RuntimeError("Media item has an invalid size")
    expected_hash = str(item.get("contentHash") or "")
    url = f"{EXPECTED_URL}/_emdash/api/media/file/{quote(storage_key, safe='')}"
    existing: tuple[str, str, int] | None = None
    if destination.is_file():
        existing = hash_file(destination)
        existing_sha1, existing_sha256, existing_size = existing
        if existing_size == expected_size and expected_hash == f"sha1:{existing_sha1}":
            return media_entry(
                item,
                destination,
                output_root,
                existing_sha1,
                existing_sha256,
                existing_size,
                "emdash_sha1",
            )
    last_detail = "verification did not match"
    for attempt in range(1, 6):
        first: Path | None = None
        second: Path | None = None
        try:
            first, sha1, sha256, size = download_once(url, destination.parent, token)
            if size != expected_size:
                last_detail = f"size mismatch on attempt {attempt}"
                continue
            if expected_hash:
                if expected_hash != f"sha1:{sha1}":
                    last_detail = f"SHA-1 mismatch on attempt {attempt}"
                    continue
                first.chmod(0o600)
                first.replace(destination)
                first = None
                return media_entry(
                    item,
                    destination,
                    output_root,
                    sha1,
                    sha256,
                    size,
                    "emdash_sha1",
                )
            if existing is not None and existing[2] == expected_size:
                if existing[1] == sha256:
                    return media_entry(
                        item,
                        destination,
                        output_root,
                        existing[0],
                        existing[1],
                        existing[2],
                        "double_download_sha256",
                    )
                existing = None
            second, second_sha1, second_sha256, second_size = download_once(
                url, destination.parent, token
            )
            if second_size != size or second_sha256 != sha256:
                last_detail = f"independent SHA-256 mismatch on attempt {attempt}"
                continue
            first.chmod(0o600)
            first.replace(destination)
            first = None
            return media_entry(
                item,
                destination,
                output_root,
                second_sha1,
                second_sha256,
                second_size,
                "double_download_sha256",
            )
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_detail = f"{type(exc).__name__} on attempt {attempt}"
        finally:
            if first is not None:
                first.unlink(missing_ok=True)
            if second is not None:
                second.unlink(missing_ok=True)
        time.sleep(min(0.75 * 2 ** (attempt - 1), 8))
    raise RuntimeError(f"Media backup verification failed: {item.get('id')} ({last_detail})")


def r2_entry(
    item: dict[str, Any],
    destination: Path,
    output_root: Path,
    sha1: str,
    sha256: str,
    size: int,
    verification: str,
) -> dict[str, Any]:
    http_metadata = item.get("http_metadata")
    content_type = (
        http_metadata.get("contentType")
        if isinstance(http_metadata, dict)
        else None
    )
    return {
        "id": None,
        "filename": item.get("key"),
        "mime_type": content_type,
        "storage_key": item.get("key"),
        "relative_path": str(destination.relative_to(output_root)),
        "bytes": size,
        "sha1": sha1,
        "sha256": sha256,
        "verification": verification,
        "status": "untracked_r2",
        "tracking": "untracked_r2",
        "etag": item.get("etag"),
        "last_modified": item.get("last_modified"),
    }


def download_r2_object(
    item: dict[str, Any], output_root: Path, account_id: str, token: str
) -> dict[str, Any]:
    storage_key = item.get("key")
    if not isinstance(storage_key, str) or not storage_key:
        raise RuntimeError("R2 object has no storage key")
    expected_size = item.get("size")
    if not isinstance(expected_size, int) or expected_size < 0:
        raise RuntimeError("R2 object has an invalid size")
    destination = storage_destination(output_root, storage_key)
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = (
        "https://api.cloudflare.com/client/v4/accounts/"
        f"{account_id}/r2/buckets/{R2_BUCKET_NAME}/objects/"
        f"{quote(storage_key, safe='')}"
    )
    existing = hash_file(destination) if destination.is_file() else None
    last_detail = "verification did not match"
    for attempt in range(1, 6):
        first: Path | None = None
        second: Path | None = None
        try:
            first, sha1, sha256, size = download_once(
                url, destination.parent, token
            )
            if size != expected_size:
                last_detail = f"size mismatch on attempt {attempt}"
                continue
            if existing is not None and existing[2] == size and existing[1] == sha256:
                return r2_entry(
                    item,
                    destination,
                    output_root,
                    existing[0],
                    existing[1],
                    existing[2],
                    "double_download_sha256",
                )
            second, second_sha1, second_sha256, second_size = download_once(
                url, destination.parent, token
            )
            if second_size != size or second_sha256 != sha256:
                last_detail = f"independent SHA-256 mismatch on attempt {attempt}"
                continue
            first.chmod(0o600)
            first.replace(destination)
            first = None
            return r2_entry(
                item,
                destination,
                output_root,
                second_sha1,
                second_sha256,
                second_size,
                "double_download_sha256",
            )
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_detail = f"{type(exc).__name__} on attempt {attempt}"
        finally:
            if first is not None:
                first.unlink(missing_ok=True)
            if second is not None:
                second.unlink(missing_ok=True)
        time.sleep(min(0.75 * 2 ** (attempt - 1), 8))
    raise RuntimeError(
        f"R2 object backup verification failed: {storage_key} ({last_detail})"
    )


class D1Client:
    def __init__(self, account_id: str, token: str) -> None:
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{DATABASE_ID}/query"
        )
        self.token = token

    def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        payload = json.dumps({"sql": sql, "params": params or []}).encode()
        for attempt in range(1, 6):
            request = Request(
                self.url,
                data=payload,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                    "User-Agent": "kanouk-backup/1.0",
                },
                method="POST",
            )
            try:
                with urlopen(request, timeout=120) as response:
                    value = json.load(response)
                if not value.get("success"):
                    raise RuntimeError("Cloudflare D1 query did not succeed")
                result = value.get("result", [])
                if not result or not result[0].get("success", True):
                    raise RuntimeError("Cloudflare D1 result did not succeed")
                rows = result[0].get("results", [])
                if not isinstance(rows, list):
                    raise RuntimeError("Cloudflare D1 returned invalid rows")
                return [row for row in rows if isinstance(row, dict)]
            except HTTPError as exc:
                detail = exc.read(2000).decode("utf-8", errors="replace")
                retryable_query_error = exc.code == 400 and (
                    "no such column: rowid" in detail or "SQLITE_BUSY" in detail
                )
                if attempt < 5 and (
                    exc.code in {429, 500, 502, 503, 504} or retryable_query_error
                ):
                    time.sleep(min(0.75 * 2 ** (attempt - 1), 8))
                    continue
                raise RuntimeError(
                    f"Cloudflare D1 HTTP {exc.code}: {detail[-1200:]}"
                ) from exc
            except (TimeoutError, URLError, OSError) as exc:
                if attempt < 5:
                    time.sleep(min(0.75 * 2 ** (attempt - 1), 8))
                    continue
                raise RuntimeError("Cloudflare D1 request failed") from exc
        raise RuntimeError("Cloudflare D1 retry loop exhausted")


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (bytes, bytearray)):
        return f"X'{bytes(value).hex()}'"
    if isinstance(value, list) and all(
        isinstance(item, int) and 0 <= item <= 255 for item in value
    ):
        return f"X'{bytes(value).hex()}'"
    if isinstance(value, dict) and value.get("type") == "Buffer" and isinstance(
        value.get("data"), list
    ):
        return sql_literal(value["data"])
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = str(value)
    if "\x00" in text:
        return f"CAST(X'{text.encode().hex()}' AS TEXT)"
    return "'" + text.replace("'", "''") + "'"


def table_rows(
    client: D1Client, table: str, *, include_rowid: bool = False
) -> tuple[list[str], list[dict[str, Any]]]:
    selected = "rowid AS __backup_rowid, *" if include_rowid else "*"
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = client.query(
            f"SELECT {selected} FROM {quote_identifier(table)} "
            "LIMIT ? OFFSET ?",
            [D1_PAGE_SIZE, offset],
        )
        rows.extend(page)
        if len(page) < D1_PAGE_SIZE:
            columns = [
                column
                for column in (rows[0].keys() if rows else [])
                if column != "__backup_rowid"
            ]
            return columns, rows
        offset += len(page)


def insert_statements(
    table: str,
    columns: list[str],
    rows: list[dict[str, Any]],
    *, include_rowid: bool = False,
) -> list[str]:
    target_columns = (["rowid"] if include_rowid else []) + columns
    quoted_columns = ", ".join(quote_identifier(column) for column in target_columns)
    statements: list[str] = []
    for row in rows:
        values = ([row.get("__backup_rowid")] if include_rowid else []) + [
            row.get(column) for column in columns
        ]
        statements.append(
            f"INSERT INTO {quote_identifier(table)} ({quoted_columns}) VALUES "
            f"({', '.join(sql_literal(value) for value in values)});"
        )
    return statements


def insert_fts_statements(
    table: str, source_table: str, columns: list[str], rows: list[dict[str, Any]]
) -> list[str]:
    if "id" not in columns:
        raise RuntimeError(f"Logical FTS table {table} has no id column")
    target_columns = ["rowid", *columns]
    quoted_columns = ", ".join(quote_identifier(column) for column in target_columns)
    statements: list[str] = []
    for row in rows:
        source_rowid = (
            f"(SELECT rowid FROM {quote_identifier(source_table)} WHERE "
            f"{quote_identifier('id')} = {sql_literal(row.get('id'))})"
        )
        values = [source_rowid, *(sql_literal(row.get(column)) for column in columns)]
        statements.append(
            f"INSERT INTO {quote_identifier(table)} ({quoted_columns}) VALUES "
            f"({', '.join(values)});"
        )
    return statements


def export_d1(destination: Path) -> dict[str, Any]:
    credential = load_cloudflare_credential()
    env = cloudflare_environment(credential)
    cloudflare_preflight(credential, env)
    client = D1Client(credential["account_id"], credential["api_token"])
    schema = client.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    tables = [
        row
        for row in schema
        if row.get("type") == "table" and isinstance(row.get("sql"), str)
    ]
    ordinary_tables = [
        row
        for row in tables
        if str(row["name"]) not in PROTECTED_D1_TABLES
        and not FTS_VIRTUAL_TABLE.fullmatch(str(row["name"]))
        and not FTS_SHADOW_TABLE.fullmatch(str(row["name"]))
    ]
    virtual_tables = [
        row
        for row in tables
        if FTS_VIRTUAL_TABLE.fullmatch(str(row["name"]))
        and not FTS_SHADOW_TABLE.fullmatch(str(row["name"]))
        and str(row["sql"]).lstrip().upper().startswith("CREATE VIRTUAL TABLE")
    ]
    trailing_schema = [
        row
        for row in schema
        if row.get("type") in {"index", "trigger", "view"}
        and isinstance(row.get("sql"), str)
    ]
    lines = [
        "PRAGMA foreign_keys=OFF;",
        "BEGIN TRANSACTION;",
    ]
    table_counts: dict[str, int] = {}
    for row in ordinary_tables:
        table = str(row["name"])
        lines.append(str(row["sql"]).rstrip(";") + ";")
        columns, rows = table_rows(client, table)
        lines.extend(insert_statements(table, columns, rows))
        table_counts[table] = len(rows)
        print(f"D1 table {table}: {len(rows)} row(s)", flush=True)
    for row in virtual_tables:
        table = str(row["name"])
        lines.append(str(row["sql"]).rstrip(";") + ";")
        columns, rows = table_rows(client, table)
        source_table = "ec_" + table.removeprefix("_emdash_fts_")
        lines.extend(insert_fts_statements(table, source_table, columns, rows))
        table_counts[table] = len(rows)
        print(f"D1 logical FTS table {table}: {len(rows)} row(s)", flush=True)
    lines.extend(str(row["sql"]).rstrip(";") + ";" for row in trailing_schema)
    lines.extend(["COMMIT;", "PRAGMA foreign_keys=ON;"])
    with tempfile.NamedTemporaryFile(
        "w", dir=destination.parent, delete=False, encoding="utf-8"
    ) as output:
        temporary = Path(output.name)
        output.write("\n".join(lines) + "\n")
    temporary.chmod(0o600)
    temporary.replace(destination)
    return {
        "ordinary_tables": len(ordinary_tables),
        "logical_fts_tables": len(virtual_tables),
        "row_counts": table_counts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_BACKUP_ROOT)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.concurrency < 1 or args.concurrency > 8:
        raise SystemExit("--concurrency must be between 1 and 8")
    credential = load_emdash_credential()
    env = emdash_environment(credential)
    emdash_preflight(env)
    media = list_media(credential["token"])
    cloudflare_credential = load_cloudflare_credential()
    cloudflare_env = cloudflare_environment(cloudflare_credential)
    cloudflare_preflight(cloudflare_credential, cloudflare_env)
    r2_objects = list_r2_objects(
        cloudflare_credential["account_id"],
        cloudflare_credential["api_token"],
    )
    media_by_key = {
        str(item.get("storageKey")): item
        for item in media
        if item.get("storageKey")
    }
    if len(media_by_key) != len(media):
        raise RuntimeError("EmDash media storage keys are missing or duplicated")
    r2_by_key = {
        str(item.get("key")): item for item in r2_objects if item.get("key")
    }
    if len(r2_by_key) != len(r2_objects):
        raise RuntimeError("R2 object keys are missing or duplicated")
    missing_from_r2 = sorted(set(media_by_key) - set(r2_by_key))
    if missing_from_r2:
        raise RuntimeError(
            f"{len(missing_from_r2)} EmDash media object(s) are missing from R2"
        )
    untracked_keys = sorted(set(r2_by_key) - set(media_by_key))
    if not args.apply:
        print(
            json.dumps(
                {
                    "apply": False,
                    "media_count": len(media),
                    "media_total_bytes": sum(
                        int(item.get("size") or 0) for item in media
                    ),
                    "r2_object_count": len(r2_objects),
                    "r2_total_bytes": sum(
                        int(item.get("size") or 0) for item in r2_objects
                    ),
                    "untracked_r2_count": len(untracked_keys),
                    "untracked_r2_total_bytes": sum(
                        int(r2_by_key[key].get("size") or 0)
                        for key in untracked_keys
                    ),
                    "missing_from_r2_count": 0,
                }
            )
        )
        return

    if args.resume:
        output_root = args.resume.resolve()
        if output_root.parent != args.output_root.resolve():
            raise SystemExit("--resume must be an existing child of --output-root")
        if not output_root.is_dir() or (output_root / "manifest.json").exists():
            raise SystemExit("--resume must identify an incomplete backup directory")
    else:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        output_root = args.output_root / timestamp
        output_root.mkdir(parents=True, exist_ok=False)
    output_root.chmod(0o700)
    d1_path = output_root / "d1.sql"
    d1_export = export_d1(d1_path)
    entries: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures: dict[Future[dict[str, Any]], str] = {}
        for storage_key, item in r2_by_key.items():
            if storage_key in media_by_key:
                future = executor.submit(
                    download_media,
                    media_by_key[storage_key],
                    output_root,
                    credential["token"],
                )
            else:
                future = executor.submit(
                    download_r2_object,
                    item,
                    output_root,
                    cloudflare_credential["account_id"],
                    cloudflare_credential["api_token"],
                )
            futures[future] = storage_key
        for index, future in enumerate(as_completed(futures), 1):
            entries.append(future.result())
            if index % 25 == 0 or index == len(futures):
                print(f"[{index}/{len(futures)}] R2 objects verified", flush=True)
    entries.sort(key=lambda item: str(item["storage_key"]))
    media_entries = [item for item in entries if item["tracking"] == "emdash"]
    untracked_entries = [
        item for item in entries if item["tracking"] == "untracked_r2"
    ]
    d1_bytes = d1_path.read_bytes()
    manifest = {
        "backup_version": 2,
        "generated_at": now_iso(),
        "source": EXPECTED_URL,
        "database": DATABASE_NAME,
        "r2_bucket": R2_BUCKET_NAME,
        "d1": {
            "relative_path": "d1.sql",
            "bytes": len(d1_bytes),
            "sha256": hashlib.sha256(d1_bytes).hexdigest(),
            **d1_export,
        },
        "media_count": len(media_entries),
        "media_total_bytes": sum(int(item["bytes"]) for item in media_entries),
        "media_verification_counts": {
            verification: sum(
                item["verification"] == verification for item in media_entries
            )
            for verification in sorted(
                {str(item["verification"]) for item in media_entries}
            )
        },
        "media": media_entries,
        "r2_object_count": len(entries),
        "r2_total_bytes": sum(int(item["bytes"]) for item in entries),
        "r2_verification_counts": {
            verification: sum(
                item["verification"] == verification for item in entries
            )
            for verification in sorted(
                {str(item["verification"]) for item in entries}
            )
        },
        "r2_objects": entries,
        "untracked_r2_count": len(untracked_entries),
        "untracked_r2_total_bytes": sum(
            int(item["bytes"]) for item in untracked_entries
        ),
        "untracked_r2": untracked_entries,
    }
    write_json_atomic(output_root / "manifest.json", manifest)
    print(
        json.dumps(
            {
                "apply": True,
                "output": str(output_root),
                "media_count": len(media_entries),
                "media_total_bytes": manifest["media_total_bytes"],
                "r2_object_count": len(entries),
                "r2_total_bytes": manifest["r2_total_bytes"],
                "untracked_r2_count": len(untracked_entries),
                "d1_sha256": manifest["d1"]["sha256"],
            }
        )
    )


if __name__ == "__main__":
    main()
