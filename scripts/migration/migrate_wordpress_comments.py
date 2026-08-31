#!/usr/bin/env python3
"""Idempotently migrate WXR comments to the pinned EmDash D1 database.

Author emails remain admin-only in EmDash. Source IP addresses and user agents
are deliberately not copied; the WXR originals remain the lossless archive.
The script emits counts only and never writes comment bodies or emails to Git or
stdout.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import sys
import time
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

from run_wrangler_kanouk import child_environment, load_credential, preflight  # noqa: E402


DATABASE_ID = "30d6fc05-588e-4c4c-9e96-2b77fe35dd82"
WP = "http://wordpress.org/export/1.2/"
SOURCES = (
    ("kanolog", Path("/Users/kanouk/Documents/Private_External_Imports/blog/wordpress.2026-07-10.xml")),
    ("nocalog", Path("/Users/kanouk/Documents/Private_External_Imports/blog/nocalog-noca.WordPress.2026-07-10.xml")),
    ("art-quiz", Path("/Users/kanouk/Documents/Private_External_Imports/blog/11.WordPress.2026-07-10.xml")),
)


class CommentText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"br", "p", "div", "li", "blockquote"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"p", "div", "li", "blockquote"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain_comment(value: str) -> str:
    parser = CommentText()
    parser.feed(unescape(value))
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    return "\n".join(line for line in lines if line).strip()


def node_text(element: ET.Element, name: str) -> str:
    child = element.find(f"{{{WP}}}{name}")
    return child.text or "" if child is not None else ""


def comment_id(site: str, source_id: str) -> str:
    return "wpc_" + hashlib.sha256(f"{site}:{source_id}".encode()).hexdigest()[:22]


def status(value: str) -> str:
    return {"1": "approved", "0": "pending", "spam": "spam", "trash": "trash", "post-trashed": "trash"}.get(value, "pending")


def iso_date(value: str) -> str:
    if not value or value.startswith("0000-00-00"):
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def parse_comments(site: str, path: Path) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    for _event, item in ET.iterparse(path, events=("end",)):
        if item.tag != "item":
            continue
        post_id = node_text(item, "post_id")
        post_type = node_text(item, "post_type")
        if post_type not in {"post", "page"}:
            item.clear()
            continue
        for source in item.findall(f"{{{WP}}}comment"):
            source_id = node_text(source, "comment_id")
            parent_source_id = node_text(source, "comment_parent")
            body = plain_comment(node_text(source, "comment_content"))
            if not source_id or not body:
                continue
            comments.append(
                {
                    "id": comment_id(site, source_id),
                    "site": site,
                    "source_id": source_id,
                    "source_post_id": post_id,
                    "parent_id": comment_id(site, parent_source_id) if parent_source_id not in {"", "0"} else None,
                    "author_name": node_text(source, "comment_author") or "匿名",
                    "author_email": node_text(source, "comment_author_email"),
                    "body": body,
                    "status": status(node_text(source, "comment_approved")),
                    "created_at": iso_date(node_text(source, "comment_date_gmt") or node_text(source, "comment_date")),
                    "moderation_metadata": json.dumps(
                        {"source_system": "wordpress", "source_site": site, "source_comment_id": source_id},
                        separators=(",", ":"),
                    ),
                }
            )
        item.clear()
    return comments


class D1Client:
    def __init__(self, account_id: str, token: str) -> None:
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{DATABASE_ID}/query"
        self.token = token

    def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        payload = json.dumps({"sql": sql, "params": params or []}, ensure_ascii=False).encode()
        for attempt in range(1, 6):
            request = Request(
                self.url,
                data=payload,
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
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
                return result[0].get("results", [])
            except HTTPError as exc:
                if attempt < 5 and exc.code in {429, 502, 503, 504}:
                    time.sleep(min(0.5 * 2 ** (attempt - 1), 8))
                    continue
                raise RuntimeError(f"Cloudflare D1 HTTP {exc.code}") from exc
            except (TimeoutError, URLError) as exc:
                if attempt < 5:
                    time.sleep(min(0.5 * 2 ** (attempt - 1), 8))
                    continue
                raise RuntimeError("Cloudflare D1 request failed") from exc
        raise RuntimeError("Cloudflare D1 retry loop exhausted")


def chunks(values: list[Any], size: int) -> Iterable[list[Any]]:
    for index in range(0, len(values), size):
        yield values[index:index + size]


def migrate(client: D1Client, comments: list[dict[str, Any]], apply: bool) -> dict[str, int]:
    content_rows = client.query(
        "SELECT id,source_id,'posts' AS collection FROM ec_posts WHERE source_id IS NOT NULL "
        "UNION ALL SELECT id,source_id,'pages' AS collection FROM ec_pages WHERE source_id IS NOT NULL"
    )
    content_targets = {row["source_id"]: (row["collection"], row["id"]) for row in content_rows}
    missing_content = [comment for comment in comments if f"{comment['site']}:{comment['source_post_id']}" not in content_targets]
    if missing_content:
        raise RuntimeError(f"{len(missing_content)} comments have no migrated content target")
    if apply:
        columns = [
            "id", "collection", "content_id", "parent_id", "author_name", "author_email",
            "author_user_id", "body", "status", "ip_hash", "user_agent", "moderation_metadata",
            "created_at", "updated_at",
        ]
        # Keep each statement below D1/SQLite's bound-variable ceiling.
        for batch in chunks(comments, 5):
            placeholders = ",".join("(" + ",".join("?" for _ in columns) + ")" for _ in batch)
            params: list[Any] = []
            for comment in batch:
                collection, content_id = content_targets[f"{comment['site']}:{comment['source_post_id']}"]
                params.extend(
                    [
                        comment["id"],
                        collection,
                        content_id,
                        comment["parent_id"],
                        comment["author_name"],
                        comment["author_email"],
                        None,
                        comment["body"],
                        comment["status"],
                        None,
                        None,
                        comment["moderation_metadata"],
                        comment["created_at"],
                        comment["created_at"],
                    ]
                )
            client.query(
                f"INSERT INTO _emdash_comments ({','.join(columns)}) VALUES {placeholders} ON CONFLICT(id) DO NOTHING",
                params,
            )
    expected = {comment["id"]: comment for comment in comments}
    actual: dict[str, dict[str, Any]] = {}
    for batch in chunks(list(expected), 50):
        rows = client.query(
            "SELECT id,collection,content_id,parent_id,author_name,author_email,body,status,moderation_metadata,created_at "
            f"FROM _emdash_comments WHERE id IN ({','.join('?' for _ in batch)})",
            batch,
        )
        actual.update({row["id"]: row for row in rows})
    if apply and len(actual) != len(expected):
        raise RuntimeError("Comment readback count mismatch")
    if apply:
        for identifier, source in expected.items():
            row = actual[identifier]
            collection, target_id = content_targets[f"{source['site']}:{source['source_post_id']}"]
            checks = {
                "collection": collection,
                "content_id": target_id,
                "parent_id": source["parent_id"],
                "author_name": source["author_name"],
                "author_email": source["author_email"],
                "body": source["body"],
                "status": source["status"],
                "moderation_metadata": source["moderation_metadata"],
                "created_at": source["created_at"],
            }
            if any(row.get(key) != value for key, value in checks.items()):
                raise RuntimeError(f"Comment readback mismatch for {identifier}")
    counts: dict[str, int] = {}
    for comment in comments:
        counts[comment["status"]] = counts.get(comment["status"], 0) + 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    credential = load_credential()
    env = child_environment(credential)
    preflight(credential, env)
    comments = [comment for site, path in SOURCES for comment in parse_comments(site, path)]
    counts = migrate(D1Client(credential["account_id"], credential["api_token"]), comments, args.apply)
    print(json.dumps({"apply": args.apply, "total": len(comments), "statuses": counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
