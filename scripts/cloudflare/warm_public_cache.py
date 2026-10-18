#!/usr/bin/env python3
"""Warm the edge cache for the most-visited public pages after a deploy.

Read-only GET requests to the public sites, so the first visitors after a deploy
get cached pages instead of waiting for the Worker to render them. The edge cache
is per data center: this warms the one closest to the machine that runs it.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import re
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

BLOG = "https://blog.kanouk.com"
PHOTOS = "https://photos.kanouk.com"
USER_AGENT = "kanouk-cache-warm/1.0"


def fetch(url: str) -> tuple[int, str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8", errors="replace")
            return response.status, response.headers.get("cf-cache-status", "-"), body
    except URLError as exc:
        return 0, str(getattr(exc, "reason", exc)), ""


def links(html: str, prefix: str, limit: int) -> list[str]:
    """Unique same-site links under prefix, in page order."""
    seen: list[str] = []
    for href in re.findall(r'href="(' + re.escape(prefix) + r'[^"?#]+)[^"]*"', html):
        if href not in seen:
            seen.append(href)
        if len(seen) >= limit:
            break
    return seen


def main() -> int:
    started = time.monotonic()
    _, _, posts_html = fetch(f"{BLOG}/posts")
    _, _, albums_html = fetch(f"{PHOTOS}/albums")
    urls = [
        f"{BLOG}/",
        f"{BLOG}/posts",
        f"{BLOG}/archives",
        *(BLOG + path for path in links(posts_html, "/posts/", 12)),
        f"{PHOTOS}/albums",
        *(PHOTOS + path for path in links(albums_html, "/albums/", 12)),
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, urls))
    failed = [url for url, (status, _, _) in zip(urls, results) if status != 200]
    statuses = {}
    for status, cache, _ in results:
        statuses[cache] = statuses.get(cache, 0) + 1
    print(f"Warmed {len(urls) - len(failed)}/{len(urls)} pages in {time.monotonic() - started:.1f}s; cache before warm: {statuses}")
    for url in failed:
        print(f"  not 200: {url}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
