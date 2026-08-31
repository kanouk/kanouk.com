#!/usr/bin/env python3
"""Fetch an explicit, reviewable WordPress REST delta without storing credentials."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


def fetch_json(url: str, username: str, password: str) -> Any:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    request = Request(
        url,
        headers={
            "Authorization": f"Basic {token}",
            "Accept": "application/json",
            "User-Agent": "kanouk-wordpress-delta/1.0",
        },
    )
    with urlopen(request, timeout=120) as response:
        return json.load(response)


def compact_post(value: dict[str, Any]) -> dict[str, Any]:
    def raw(field: str) -> str:
        candidate = value.get(field, {})
        return str(candidate.get("raw", candidate.get("rendered", ""))) if isinstance(candidate, dict) else str(candidate or "")

    return {
        "id": int(value["id"]),
        "title": raw("title"),
        "content": raw("content"),
        "excerpt": raw("excerpt"),
        "date": value.get("date"),
        "date_gmt": value.get("date_gmt"),
        "modified": value.get("modified"),
        "modified_gmt": value.get("modified_gmt"),
        "slug": value.get("slug", ""),
        "status": value.get("status", ""),
        "link": value.get("link", ""),
        "author": value.get("author"),
        "featured_media": value.get("featured_media"),
        "categories": value.get("categories", []),
        "tags": value.get("tags", []),
        "meta": value.get("meta", {}),
        "comment_status": value.get("comment_status", ""),
        "ping_status": value.get("ping_status", ""),
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.chmod(0o600)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    parser.add_argument("--id", type=int, action="append", required=True)
    parser.add_argument("--username-env", default="WP_AUDIT_USER")
    parser.add_argument("--password-env", default="WP_AUDIT_PASSWORD")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    username = os.environ.get(args.username_env, "")
    password = os.environ.get(args.password_env, "")
    if not username or not password:
        raise SystemExit("WordPress credentials must be supplied through environment variables")
    api = urljoin(args.site.rstrip("/") + "/", "wp-json/wp/v2/")
    fields = (
        "id,title,content,excerpt,date,date_gmt,modified,modified_gmt,slug,status,link,"
        "author,featured_media,categories,tags,meta,comment_status,ping_status"
    )
    posts = []
    for post_id in sorted(set(args.id)):
        query = urlencode({"context": "edit", "_fields": fields})
        posts.append(compact_post(fetch_json(f"{api}posts/{post_id}?{query}", username, password)))
    category_ids = sorted({int(value) for post in posts for value in post["categories"]})
    tag_ids = sorted({int(value) for post in posts for value in post["tags"]})
    terms = {"categories": {}, "tags": {}}
    for kind, ids in (("categories", category_ids), ("tags", tag_ids)):
        for term_id in ids:
            term = fetch_json(f"{api}{kind}/{term_id}?" + urlencode({"context": "edit"}), username, password)
            terms[kind][str(term_id)] = {"slug": term["slug"], "name": term["name"]}
    payload = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "site": args.site.rstrip("/"),
        "post_ids": [post["id"] for post in posts],
        "posts": posts,
        "terms": terms,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    payload["payload_sha256"] = hashlib.sha256(canonical).hexdigest()
    write_json_atomic(args.output, payload)
    print(json.dumps({"posts": len(posts), "post_ids": payload["post_ids"], "output": str(args.output)}))


if __name__ == "__main__":
    main()
