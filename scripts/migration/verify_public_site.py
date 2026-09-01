#!/usr/bin/env python3
"""Read-only health check for the Yohaku blog and public photo archive."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from html import unescape
import json
import re
import time
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


USER_AGENT = "kanouk-migration-monitor/1.0"
MAX_HTML_BYTES = 2 * 1024 * 1024


@dataclass
class Check:
    name: str
    url: str
    ok: bool
    status: int | None
    elapsed_ms: int
    detail: str


def fetch(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    max_bytes: int = MAX_HTML_BYTES,
) -> tuple[int, Mapping[str, str], bytes, int]:
    request_headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
    if headers:
        request_headers.update(headers)
    started = time.monotonic()
    try:
        with urlopen(Request(url, headers=request_headers), timeout=30) as response:
            body = response.read(max_bytes)
            elapsed_ms = round((time.monotonic() - started) * 1000)
            return response.status, dict(response.headers.items()), body, elapsed_ms
    except HTTPError as error:
        body = error.read(max_bytes)
        elapsed_ms = round((time.monotonic() - started) * 1000)
        return error.code, dict(error.headers.items()), body, elapsed_ms


def header(headers: Mapping[str, str], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return ""


def add_page_check(
    checks: list[Check],
    *,
    name: str,
    url: str,
    expected_status: int,
    marker: str,
    expect_preview_noindex: bool,
) -> str:
    status, headers, body, elapsed_ms = fetch(url)
    text = body.decode("utf-8", errors="replace")
    failures: list[str] = []
    if status != expected_status:
        failures.append(f"status={status}, expected={expected_status}")
    if marker not in text:
        failures.append(f"missing marker={marker!r}")
    if expected_status == 200 and "text/html" not in header(headers, "Content-Type"):
        failures.append("response is not HTML")
    if expect_preview_noindex and "noindex" not in header(headers, "X-Robots-Tag").lower():
        failures.append("preview noindex header missing")
    if header(headers, "X-Content-Type-Options").lower() != "nosniff":
        failures.append("nosniff header missing")
    if not header(headers, "Referrer-Policy"):
        failures.append("referrer policy missing")
    checks.append(
        Check(
            name=name,
            url=url,
            ok=not failures,
            status=status,
            elapsed_ms=elapsed_ms,
            detail="ok" if not failures else "; ".join(failures),
        )
    )
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="https://kanouk-emdash-staging.kanouk.workers.dev",
    )
    parser.add_argument(
        "--expect-preview-noindex",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require X-Robots-Tag: noindex on every checked HTML page.",
    )
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/") + "/"
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("--base-url must be an absolute HTTP(S) URL")

    checks: list[Check] = []
    try:
        add_page_check(
            checks,
            name="blog-home",
            url=urljoin(base_url, "/"),
            expected_status=200,
            marker="カノログ",
            expect_preview_noindex=args.expect_preview_noindex,
        )
        add_page_check(
            checks,
            name="post-archive",
            url=urljoin(base_url, "/posts"),
            expected_status=200,
            marker="すべての記事",
            expect_preview_noindex=args.expect_preview_noindex,
        )
        albums_html = add_page_check(
            checks,
            name="album-archive",
            url=urljoin(base_url, "/albums"),
            expected_status=200,
            marker="<h1>アルバム</h1>",
            expect_preview_noindex=args.expect_preview_noindex,
        )
        add_page_check(
            checks,
            name="photo-search",
            url=urljoin(base_url, "/photo-search?q=%E4%BA%AC%E9%83%BD"),
            expected_status=200,
            marker="写真を検索",
            expect_preview_noindex=args.expect_preview_noindex,
        )
        add_page_check(
            checks,
            name="not-found",
            url=urljoin(base_url, "/definitely-missing-yohaku-monitor"),
            expected_status=404,
            marker="404",
            expect_preview_noindex=args.expect_preview_noindex,
        )

        sitemap_url = urljoin(base_url, "/sitemap.xml")
        status, headers, body, elapsed_ms = fetch(sitemap_url)
        sitemap_text = body.decode("utf-8", errors="replace")
        sitemap_failures: list[str] = []
        if status != 200:
            sitemap_failures.append(f"status={status}, expected=200")
        if "application/xml" not in header(headers, "Content-Type"):
            sitemap_failures.append("response is not XML")
        for expected in ("sitemap-posts.xml", "sitemap-albums.xml"):
            if expected not in sitemap_text:
                sitemap_failures.append(f"missing {expected}")
        if args.expect_preview_noindex and "noindex" not in header(headers, "X-Robots-Tag").lower():
            sitemap_failures.append("preview noindex header missing")
        checks.append(
            Check(
                name="sitemap-index",
                url=sitemap_url,
                ok=not sitemap_failures,
                status=status,
                elapsed_ms=elapsed_ms,
                detail="ok" if not sitemap_failures else "; ".join(sitemap_failures),
            )
        )

        image_match = re.search(r'<img\s[^>]*src="([^"]+)"', albums_html)
        if image_match:
            image_url = urljoin(base_url, unescape(image_match.group(1)))
            status, headers, body, elapsed_ms = fetch(
                image_url,
                headers={"Range": "bytes=0-63"},
                max_bytes=64,
            )
            image_failures: list[str] = []
            if status not in {200, 206}:
                image_failures.append(f"status={status}, expected=200/206")
            if not header(headers, "Content-Type").lower().startswith("image/"):
                image_failures.append("response is not an image")
            if not body:
                image_failures.append("empty image response")
            checks.append(
                Check(
                    name="media-readback",
                    url=image_url,
                    ok=not image_failures,
                    status=status,
                    elapsed_ms=elapsed_ms,
                    detail="ok" if not image_failures else "; ".join(image_failures),
                )
            )
        else:
            checks.append(
                Check(
                    name="media-readback",
                    url=urljoin(base_url, "/albums"),
                    ok=False,
                    status=None,
                    elapsed_ms=0,
                    detail="no migrated album cover found",
                )
            )
    except (URLError, TimeoutError, OSError) as error:
        checks.append(
            Check(
                name="network",
                url=base_url,
                ok=False,
                status=None,
                elapsed_ms=0,
                detail=f"{type(error).__name__}: {error}",
            )
        )

    failures = [check for check in checks if not check.ok]
    print(
        json.dumps(
            {
                "verified": not failures,
                "base_url": base_url.rstrip("/"),
                "expect_preview_noindex": args.expect_preview_noindex,
                "checks": [asdict(check) for check in checks],
                "failed": len(failures),
            },
            ensure_ascii=False,
        )
    )
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
