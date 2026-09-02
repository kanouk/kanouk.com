#!/usr/bin/env python3
"""Crawl every public sitemap URL and report migration/HTML regressions."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
import json
import re
import time
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree


USER_AGENT = "kanouk-full-public-audit/1.0"
RETRY_STATUSES = {404, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
MAX_FETCH_ATTEMPTS = 5
FORBIDDEN = {
    "wordpress_pseudo_url": re.compile(rb"wordpress://", re.IGNORECASE),
    "wordpress_upload": re.compile(
        rb"(?:kanolog\.net|nocalog\.net|kanologue\.com)/wp-content/uploads",
        re.IGNORECASE,
    ),
    "smugmug": re.compile(rb"(?:smugmug\.com|smugmugcdn\.com)", re.IGNORECASE),
    "legacy_site_link": re.compile(
        rb"https?://(?:www\.)?(?:kanolog\.net|nocalog\.net|art-quiz\.com)(?:[/\"'?#]|$)",
        re.IGNORECASE,
    ),
    "gutenberg_comment": re.compile(rb"<!--\s*/?wp:", re.IGNORECASE),
    "legacy_shortcode": re.compile(
        rb"\[(?:quiz|pochipp|swell|jin|speech_balloon|blogcard)(?:\s|\])",
        re.IGNORECASE,
    ),
    "plugin_placeholder": re.compile(rb"Plugin block:\s*[^<(]+", re.IGNORECASE),
}
SMUGMUG_REFERENCE = re.compile(
    rb"(?:https?:)?//[^\s\"'<>]*(?:smugmug\.com|smugmugcdn\.com)[^\s\"'<>]*",
    re.IGNORECASE,
)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []
        self.has_title = False
        self._inside_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self.hrefs.append(values["href"] or "")
        if tag == "title":
            self._inside_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._inside_title = False

    def handle_data(self, data: str) -> None:
        if self._inside_title and data.strip():
            self.has_title = True


@dataclass
class Failure:
    url: str
    kind: str
    detail: str


def fetch(
    url: str, *, max_bytes: int = 4 * 1024 * 1024
) -> tuple[int, Mapping[str, str], bytes, str]:
    for attempt in range(1, MAX_FETCH_ATTEMPTS + 1):
        try:
            with urlopen(
                Request(
                    url,
                    headers={
                        "User-Agent": USER_AGENT,
                        "Accept-Encoding": "identity",
                    },
                ),
                timeout=45,
            ) as response:
                return (
                    response.status,
                    dict(response.headers.items()),
                    response.read(max_bytes),
                    response.geturl(),
                )
        except HTTPError as exc:
            if attempt < MAX_FETCH_ATTEMPTS and exc.code in RETRY_STATUSES:
                time.sleep(min(0.75 * (2 ** (attempt - 1)), 4.0))
                continue
            return exc.code, dict(exc.headers.items()), exc.read(max_bytes), url
        except (TimeoutError, URLError, OSError):
            if attempt == MAX_FETCH_ATTEMPTS:
                raise
            time.sleep(min(0.75 * (2 ** (attempt - 1)), 4.0))
    raise RuntimeError("fetch retry loop exhausted")


def header(headers: Mapping[str, str], name: str) -> str:
    target = name.lower()
    return next((value for key, value in headers.items() if key.lower() == target), "")


def on_base_origin(url: str, base_url: str) -> bool:
    candidate = urlparse(url)
    base = urlparse(base_url)
    return candidate.scheme in {"http", "https"} and candidate.netloc == base.netloc


def normalize_link(value: str, page_url: str) -> str | None:
    if not value or value.startswith(("mailto:", "tel:", "javascript:", "data:")):
        return None
    absolute, _ = urldefrag(urljoin(page_url, value))
    return absolute or None


def count_forbidden(
    name: str, body: bytes, *, allowed_smugmug_ids: list[str]
) -> int:
    """Count residue without letting one allowed image hide its whole page."""
    pattern = FORBIDDEN[name]
    if name != "smugmug" or not allowed_smugmug_ids:
        return len(pattern.findall(body))

    allowed = [image_id.encode() for image_id in allowed_smugmug_ids]
    scrubbed = body
    for reference in SMUGMUG_REFERENCE.findall(body):
        if any(image_id in reference for image_id in allowed):
            scrubbed = scrubbed.replace(reference, b"")
    return len(pattern.findall(scrubbed))


def sitemap_urls(base_url: str) -> tuple[list[str], list[str]]:
    index_url = urljoin(base_url.rstrip("/") + "/", "sitemap.xml")
    status, _, body, _ = fetch(index_url)
    if status != 200:
        raise RuntimeError(f"sitemap index returned HTTP {status}")
    root = ElementTree.fromstring(body)
    child_urls = [node.text for node in root.findall("{*}sitemap/{*}loc") if node.text]
    public_urls: list[str] = []
    base = urlparse(base_url)
    for child_url in child_urls:
        child = urlparse(child_url)
        local_child = urlunparse(child._replace(scheme=base.scheme, netloc=base.netloc))
        child_status, _, child_body, _ = fetch(local_child)
        if child_status != 200:
            raise RuntimeError(f"child sitemap returned HTTP {child_status}: {local_child}")
        child_root = ElementTree.fromstring(child_body)
        for node in child_root.findall("{*}url/{*}loc"):
            if not node.text:
                continue
            parsed = urlparse(node.text)
            public_urls.append(
                urlunparse(parsed._replace(scheme=base.scheme, netloc=base.netloc))
            )
    return child_urls, list(dict.fromkeys(public_urls))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="https://kanouk-emdash-staging.kanouk.workers.dev",
    )
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument(
        "--expect-preview-noindex",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--allow-smugmug-id",
        action="append",
        default=[],
        help="Allow a known owner-auth-blocked SmugMug image key on its page only.",
    )
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.concurrency < 1 or args.concurrency > 8:
        raise SystemExit("--concurrency must be between 1 and 8")
    base_url = args.base_url.rstrip("/")
    parsed_base = urlparse(base_url)
    if parsed_base.scheme not in {"http", "https"} or not parsed_base.netloc:
        raise SystemExit("--base-url must be an absolute HTTP(S) URL")

    started = time.monotonic()
    child_sitemaps, pages = sitemap_urls(base_url)
    failures: list[Failure] = []
    internal_links: set[str] = set()
    forbidden_counts = {name: 0 for name in FORBIDDEN}

    def audit_page(url: str) -> tuple[list[Failure], list[str], dict[str, int]]:
        local_failures: list[Failure] = []
        local_counts = {name: 0 for name in FORBIDDEN}
        try:
            status, headers, body, final_url = fetch(url)
        except Exception as exc:
            return [Failure(url, "network", f"{type(exc).__name__}: {exc}")], [], local_counts
        if status != 200:
            local_failures.append(Failure(url, "status", f"HTTP {status}"))
            return local_failures, [], local_counts
        if "text/html" not in header(headers, "Content-Type").lower():
            local_failures.append(Failure(url, "content_type", header(headers, "Content-Type")))
        if args.expect_preview_noindex and "noindex" not in header(
            headers, "X-Robots-Tag"
        ).lower():
            local_failures.append(Failure(url, "robots", "preview noindex header missing"))
        for name in FORBIDDEN:
            count = count_forbidden(
                name, body, allowed_smugmug_ids=args.allow_smugmug_id
            )
            local_counts[name] = count
            if count:
                local_failures.append(Failure(url, name, f"{count} match(es)"))
        parser = PageParser()
        parser.feed(body.decode("utf-8", errors="replace"))
        if not parser.has_title:
            local_failures.append(Failure(url, "title", "missing or empty title"))
        links = [
            link
            for href in parser.hrefs
            if (link := normalize_link(href, final_url)) and on_base_origin(link, base_url)
        ]
        return local_failures, links, local_counts

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {executor.submit(audit_page, url): url for url in pages}
        for future in as_completed(futures):
            page_failures, links, counts = future.result()
            failures.extend(page_failures)
            internal_links.update(links)
            for name, count in counts.items():
                forbidden_counts[name] += count

    link_failures: list[Failure] = []

    def check_link(url: str) -> Failure | None:
        try:
            status, _, _, _ = fetch(url, max_bytes=1)
        except Exception as exc:
            return Failure(url, "internal_link_network", f"{type(exc).__name__}: {exc}")
        if status >= 400:
            return Failure(url, "internal_link_status", f"HTTP {status}")
        return None

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {executor.submit(check_link, url): url for url in sorted(internal_links)}
        for future in as_completed(futures):
            if failure := future.result():
                link_failures.append(failure)
    failures.extend(link_failures)

    report = {
        "verified": not failures,
        "base_url": base_url,
        "allowed_smugmug_ids": sorted(set(args.allow_smugmug_id)),
        "child_sitemaps": len(child_sitemaps),
        "public_pages": len(pages),
        "internal_links": len(internal_links),
        "forbidden_counts": forbidden_counts,
        "failure_count": len(failures),
        "failures": [asdict(failure) for failure in failures[:500]],
        "failures_truncated": max(0, len(failures) - 500),
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as output:
            output.write(encoded + "\n")
    print(encoded)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
