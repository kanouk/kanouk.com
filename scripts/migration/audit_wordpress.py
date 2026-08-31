#!/usr/bin/env python3
"""Privacy-preserving WordPress source audit for the EmDash migration.

The report contains counts, schema keys, block/shortcode names, MIME types, and
referenced host names. It never writes post titles, slugs, bodies, excerpts,
user names, or credentials.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


BLOCK_RE = re.compile(r"<!--\s+wp:([^\s/{]+)")
SHORTCODE_RE = re.compile(r"\[([A-Za-z][A-Za-z0-9_-]*)(?:\s|\]|/)")
URL_RE = re.compile(r"https?://[^\s\"'<>\])}]+", re.IGNORECASE)


class TagCounter(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: Counter[str] = Counter()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags[tag.lower()] += 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags[tag.lower()] += 1


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def increment(counter: Counter[str], value: Any) -> None:
    if isinstance(value, str) and value:
        counter[value] += 1


def content_signals(text: str, target: dict[str, Counter[str]]) -> None:
    if not text:
        return
    target["gutenberg_blocks"].update(BLOCK_RE.findall(text))
    target["shortcodes"].update(SHORTCODE_RE.findall(text))
    parser = TagCounter()
    try:
        parser.feed(text)
    except Exception:
        pass
    target["html_tags"].update(parser.tags)
    for raw_url in URL_RE.findall(text):
        host = (urlparse(raw_url).hostname or "").lower()
        if host:
            target["url_hosts"][host] += 1


def sorted_counter(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items(), key=lambda pair: (-pair[1], pair[0])))


def empty_signals() -> dict[str, Counter[str]]:
    return {
        "gutenberg_blocks": Counter(),
        "shortcodes": Counter(),
        "html_tags": Counter(),
        "url_hosts": Counter(),
    }


class WordPressClient:
    def __init__(self, site: str, username: str | None, password: str | None) -> None:
        self.site = site.rstrip("/")
        self.api = f"{self.site}/wp-json/wp/v2"
        self.authenticated = bool(username and password)
        self.headers = {"User-Agent": "kanouk-migration-audit/1.0"}
        if self.authenticated:
            token = base64.b64encode(f"{username}:{password}".encode()).decode()
            self.headers["Authorization"] = f"Basic {token}"

    def get(self, path: str, params: dict[str, Any] | None = None) -> tuple[Any, dict[str, str]]:
        query = f"?{urlencode(params, doseq=True)}" if params else ""
        request = Request(f"{self.api}/{path.lstrip('/')}{query}", headers=self.headers)
        with urlopen(request, timeout=60) as response:
            headers = {key.lower(): value for key, value in response.headers.items()}
            return json.load(response), headers


def rest_total(client: WordPressClient, path: str, params: dict[str, Any]) -> int | None:
    try:
        _, headers = client.get(path, {**params, "per_page": 1})
        return int(headers["x-wp-total"])
    except (HTTPError, URLError, KeyError, ValueError):
        return None


def iter_rest_records(
    client: WordPressClient, path: str, authenticated: bool
) -> Iterable[dict[str, Any]]:
    page = 1
    use_status_any = authenticated
    while True:
        params: dict[str, Any] = {"per_page": 100, "page": page}
        if authenticated:
            params["context"] = "edit"
            if use_status_any:
                params["status"] = "any"
        try:
            records, headers = client.get(path, params)
        except HTTPError as exc:
            # The media endpoint rejects status=any on some WordPress builds,
            # while returning every readable attachment when status is omitted.
            if exc.code == 400 and authenticated and "status" in params:
                params.pop("status", None)
                use_status_any = False
                records, headers = client.get(path, params)
            elif exc.code == 400 and page > 1:
                return
            else:
                raise
        if not isinstance(records, list):
            return
        yield from (record for record in records if isinstance(record, dict))
        total_pages = int(headers.get("x-wp-totalpages", "1"))
        if page >= total_pages:
            return
        page += 1


def audit_rest(args: argparse.Namespace) -> dict[str, Any]:
    username = os.environ.get(args.username_env) if args.username_env else None
    password = os.environ.get(args.password_env) if args.password_env else None
    if bool(username) != bool(password):
        raise SystemExit("Both username and application password must be supplied")

    client = WordPressClient(args.site, username, password)
    errors: list[dict[str, str]] = []
    authenticated = False
    if client.authenticated:
        try:
            client.get("users/me", {"context": "edit", "_fields": "id"})
            authenticated = True
        except (HTTPError, URLError) as exc:
            errors.append({"scope": "authentication", "error": type(exc).__name__})

    context = "edit" if authenticated else "view"
    try:
        types, _ = client.get("types", {"context": context})
    except HTTPError:
        types, _ = client.get("types")
        context = "view"
    try:
        taxonomies, _ = client.get("taxonomies", {"context": context})
    except HTTPError:
        taxonomies, _ = client.get("taxonomies")

    signals = empty_signals()
    meta_keys: Counter[str] = Counter()
    mime_types: Counter[str] = Counter()
    type_reports: dict[str, Any] = {}
    all_statuses = ("publish", "draft", "pending", "private", "future", "inherit")

    for type_name, definition in sorted(types.items()):
        if not isinstance(definition, dict):
            continue
        rest_base = definition.get("rest_base") or type_name
        status_totals: dict[str, int] = {}
        for status in all_statuses:
            if not authenticated and status != "publish":
                continue
            total = rest_total(
                client,
                rest_base,
                {"context": context, "status": status},
            )
            if total:
                status_totals[status] = total

        fetched_statuses: Counter[str] = Counter()
        featured_media = 0
        records_with_raw_content = 0
        records_with_rendered_content = 0
        records_fetched = 0
        try:
            for record in iter_rest_records(client, rest_base, authenticated):
                records_fetched += 1
                increment(fetched_statuses, record.get("status"))
                if record.get("featured_media"):
                    featured_media += 1
                increment(mime_types, record.get("mime_type"))
                meta = record.get("meta")
                if isinstance(meta, dict):
                    meta_keys.update(str(key) for key in meta)
                for field in ("content", "excerpt", "description", "caption"):
                    value = record.get(field)
                    if isinstance(value, dict):
                        raw = value.get("raw")
                        rendered = value.get("rendered")
                        if isinstance(raw, str) and raw:
                            records_with_raw_content += field == "content"
                            content_signals(raw, signals)
                        elif isinstance(rendered, str) and rendered:
                            records_with_rendered_content += field == "content"
                            content_signals(rendered, signals)
                    elif isinstance(value, str):
                        content_signals(value, signals)
        except (HTTPError, URLError) as exc:
            errors.append({"scope": f"type:{type_name}", "error": type(exc).__name__})

        type_reports[type_name] = {
            "rest_base": rest_base,
            "hierarchical": bool(definition.get("hierarchical")),
            "status_totals_from_headers": status_totals,
            "records_fetched": records_fetched,
            "fetched_statuses": sorted_counter(fetched_statuses),
            "records_with_raw_content": records_with_raw_content,
            "records_with_rendered_content": records_with_rendered_content,
            "records_with_featured_media": featured_media,
        }

    taxonomy_report = {
        name: {
            "rest_base": definition.get("rest_base") or name,
            "hierarchical": bool(definition.get("hierarchical")),
            "types": sorted(definition.get("types") or []),
        }
        for name, definition in sorted(taxonomies.items())
        if isinstance(definition, dict)
    }

    comment_params = {"context": context}
    if authenticated:
        comment_params["status"] = "all"
    comments = rest_total(client, "comments", comment_params)
    users = rest_total(client, "users", {"context": context})

    return {
        "report_version": 1,
        "source": "wordpress-rest",
        "generated_at": now_iso(),
        "site_host": urlparse(args.site).hostname,
        "authenticated": authenticated,
        "content_scope": "all-readable-statuses" if authenticated else "public-only",
        "post_types": type_reports,
        "taxonomies": taxonomy_report,
        "comments_total": comments,
        "users_total": users,
        "meta_keys": sorted_counter(meta_keys),
        "mime_types": sorted_counter(mime_types),
        "content_signals": {key: sorted_counter(value) for key, value in signals.items()},
        "errors": errors,
    }


def child_text(element: ET.Element, local_name: str) -> str:
    for child in element:
        if child.tag.rsplit("}", 1)[-1] == local_name:
            return child.text or ""
    return ""


def audit_wxr(args: argparse.Namespace) -> dict[str, Any]:
    post_types: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    type_statuses: dict[str, Counter[str]] = {}
    meta_keys: Counter[str] = Counter()
    mime_types: Counter[str] = Counter()
    taxonomies: Counter[str] = Counter()
    signals = empty_signals()
    item_count = 0

    for wxr_path in args.files:
        for _, element in ET.iterparse(wxr_path, events=("end",)):
            if element.tag.rsplit("}", 1)[-1] != "item":
                continue
            item_count += 1
            post_type = child_text(element, "post_type") or "unknown"
            status = child_text(element, "status") or "unknown"
            post_types[post_type] += 1
            statuses[status] += 1
            type_statuses.setdefault(post_type, Counter())[status] += 1
            increment(mime_types, child_text(element, "attachment_url").rsplit(".", 1)[-1].lower())
            for child in element:
                local = child.tag.rsplit("}", 1)[-1]
                if local in {"encoded", "excerpt"}:
                    content_signals(child.text or "", signals)
                elif local == "category":
                    increment(taxonomies, child.attrib.get("domain"))
                elif local == "postmeta":
                    key = child_text(child, "meta_key")
                    if key:
                        meta_keys[key] += 1
            element.clear()

    return {
        "report_version": 1,
        "source": "wordpress-wxr",
        "generated_at": now_iso(),
        "file_count": len(args.files),
        "items_total": item_count,
        "post_types": sorted_counter(post_types),
        "statuses": sorted_counter(statuses),
        "post_type_statuses": {
            key: sorted_counter(value) for key, value in sorted(type_statuses.items())
        },
        "meta_keys": sorted_counter(meta_keys),
        "attachment_extensions": sorted_counter(mime_types),
        "taxonomy_assignments": sorted_counter(taxonomies),
        "content_signals": {key: sorted_counter(value) for key, value in signals.items()},
    }


def write_report(report: dict[str, Any], output: str | None) -> None:
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(rendered)
    else:
        sys.stdout.write(rendered)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)

    rest = subparsers.add_parser("rest", help="Audit a WordPress REST API")
    rest.add_argument("--site", required=True, help="WordPress site URL")
    rest.add_argument("--username-env", help="Environment variable containing the username")
    rest.add_argument("--password-env", help="Environment variable containing the application password")
    rest.add_argument("--output", help="JSON output path (stdout when omitted)")
    rest.set_defaults(handler=audit_rest)

    wxr = subparsers.add_parser("wxr", help="Audit one or more WXR XML files")
    wxr.add_argument("files", nargs="+", help="WXR XML paths")
    wxr.add_argument("--output", help="JSON output path (stdout when omitted)")
    wxr.set_defaults(handler=audit_wxr)
    return root


def main() -> None:
    args = parser().parse_args()
    write_report(args.handler(args), args.output)


if __name__ == "__main__":
    main()
