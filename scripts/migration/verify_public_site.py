#!/usr/bin/env python3
"""Read-only health check for the Yohaku blog and public photo archive."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from html import unescape
from html.parser import HTMLParser
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


class SeoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.canonicals: list[str] = []
        self.stylesheets: list[str] = []
        self.meta: dict[str, list[str]] = {}
        self.jsonld_types: list[str] = []
        self._jsonld_parts: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "link":
            rels = values.get("rel", "").lower().split()
            if "canonical" in rels:
                self.canonicals.append(values.get("href", ""))
            if "stylesheet" in rels:
                self.stylesheets.append(values.get("href", ""))
        if tag.lower() == "meta":
            key = values.get("property") or values.get("name")
            if key:
                self.meta.setdefault(key.lower(), []).append(values.get("content", ""))
        if tag.lower() == "script" and values.get("type", "").lower() == "application/ld+json":
            self._jsonld_parts = []

    def handle_data(self, data: str) -> None:
        if self._jsonld_parts is not None:
            self._jsonld_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "script" or self._jsonld_parts is None:
            return
        raw = "".join(self._jsonld_parts).strip()
        self._jsonld_parts = None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.jsonld_types.append("INVALID")
            return
        if isinstance(payload, dict):
            value = payload.get("@type")
            if isinstance(value, str):
                self.jsonld_types.append(value)


def add_seo_check(
    checks: list[Check],
    *,
    name: str,
    url: str,
    html: str,
    expected_canonical: str | None,
    expected_jsonld: str,
    require_og_image: bool = False,
) -> None:
    parser = SeoParser()
    parser.feed(html)
    failures: list[str] = []
    expected_canonicals = [] if expected_canonical is None else [expected_canonical]
    if parser.canonicals != expected_canonicals:
        failures.append(
            f"canonical={parser.canonicals!r}, expected={expected_canonicals!r}"
        )
    if parser.jsonld_types != [expected_jsonld]:
        failures.append(
            f"jsonld={parser.jsonld_types!r}, expected={[expected_jsonld]!r}"
        )
    if len(parser.meta.get("og:title", [])) != 1:
        failures.append("expected exactly one og:title")
    if require_og_image:
        images = parser.meta.get("og:image", [])
        if len(images) != 1 or not images[0].startswith("https://"):
            failures.append("expected exactly one absolute og:image")
    checks.append(
        Check(
            name=name,
            url=url,
            ok=not failures,
            status=200,
            elapsed_ms=0,
            detail="ok" if not failures else "; ".join(failures),
        )
    )


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


def responsive_media_url(html: str) -> str | None:
    match = re.search(
        r'<img\s[^>]*src="([^"]*?/_yohaku/media/preview-v2/[^"]+)"',
        html,
    )
    return unescape(match.group(1)) if match else None


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


def add_media_check(checks: list[Check], *, name: str, url: str) -> None:
    status, headers, body, elapsed_ms = fetch(url, max_bytes=1024)
    failures: list[str] = []
    if status != 200:
        failures.append(f"status={status}, expected=200")
    if not header(headers, "Content-Type").lower().startswith(("image/", "video/")):
        failures.append("response is not image/video media")
    if not body:
        failures.append("empty media response")
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


def add_stylesheet_check(
    checks: list[Check], *, base_url: str, html: str
) -> None:
    parser = SeoParser()
    parser.feed(html)
    stylesheets = [urljoin(base_url, href) for href in parser.stylesheets if href]
    if not stylesheets:
        checks.append(
            Check(
                name="design-stylesheet",
                url=base_url,
                ok=False,
                status=None,
                elapsed_ms=0,
                detail="no external stylesheet found",
            )
        )
        return

    has_yohaku_contract = False
    for index, stylesheet_url in enumerate(stylesheets, start=1):
        status, headers, body, elapsed_ms = fetch(
            stylesheet_url,
            headers={"Accept": "text/css,*/*;q=0.1"},
            max_bytes=256 * 1024,
        )
        failures: list[str] = []
        if status != 200:
            failures.append(f"status={status}, expected=200")
        if "text/css" not in header(headers, "Content-Type").lower():
            failures.append("response is not CSS")
        if len(body) < 1024:
            failures.append(f"stylesheet is unexpectedly small ({len(body)} bytes)")
        has_yohaku_contract = has_yohaku_contract or b"--paper:" in body or b".site" in body
        checks.append(
            Check(
                name=(
                    "design-stylesheet"
                    if len(stylesheets) == 1
                    else f"design-stylesheet-{index}"
                ),
                url=stylesheet_url,
                ok=not failures,
                status=status,
                elapsed_ms=elapsed_ms,
                detail="ok" if not failures else "; ".join(failures),
            )
        )
    checks.append(
        Check(
            name="design-theme-contract",
            url=base_url,
            ok=has_yohaku_contract,
            status=200,
            elapsed_ms=0,
            detail="ok" if has_yohaku_contract else "Yohaku design tokens are missing from all stylesheets",
        )
    )


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
    is_photos_host = parsed.hostname == "photos.kanouk.com"

    checks: list[Check] = []
    try:
        home_html = add_page_check(
            checks,
            name="photo-home" if is_photos_host else "blog-home",
            url=urljoin(base_url, "/"),
            expected_status=200,
            marker="<h1>アルバム</h1>" if is_photos_host else "カノログ",
            expect_preview_noindex=args.expect_preview_noindex,
        )
        add_stylesheet_check(checks, base_url=base_url, html=home_html)
        posts_html = add_page_check(
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

        add_seo_check(
            checks,
            name="photo-home-seo" if is_photos_host else "blog-home-seo",
            url=urljoin(base_url, "/"),
            html=home_html,
            expected_canonical=(
                "https://photos.kanouk.com/albums"
                if is_photos_host
                else "https://blog.kanouk.com/"
            ),
            expected_jsonld="WebSite",
        )

        if not is_photos_host:
            post_match = re.search(r'href="(/posts/[^"?#]+)"', home_html)
            if not post_match:
                raise RuntimeError("no published post found for SEO readback")
            post_path = unescape(post_match.group(1))
            post_url = urljoin(base_url, post_path)
            post_html = add_page_check(
                checks,
                name="post-detail",
                url=post_url,
                expected_status=200,
                marker='class="article"',
                expect_preview_noindex=args.expect_preview_noindex,
            )
            add_seo_check(
                checks,
                name="post-detail-seo",
                url=post_url,
                html=post_html,
                expected_canonical=urljoin("https://blog.kanouk.com", post_path),
                expected_jsonld="BlogPosting",
                require_og_image=True,
            )

            # This legacy article uses a migrated WordPress media id whose R2
            # storage key differs from that id. It guards the renderer contract
            # and verifies that the responsive edge rendition is publicly readable.
            legacy_media_path = "/posts/post-dc5c"
            legacy_media_html = add_page_check(
                checks,
                name="legacy-inline-media-post",
                url=urljoin(base_url, legacy_media_path),
                expected_status=200,
                marker='class="yohaku-portable-image style-photo-frame"',
                expect_preview_noindex=args.expect_preview_noindex,
            )
            legacy_media_url = responsive_media_url(legacy_media_html)
            if not legacy_media_url:
                raise RuntimeError("responsive inline media URL was not rendered")
            add_media_check(
                checks,
                name="legacy-inline-media-readback",
                url=urljoin(base_url, legacy_media_url),
            )

        album_match = re.search(r'href="(/albums/[^"?#]+)"', albums_html)
        if not album_match:
            raise RuntimeError("no published album found for SEO readback")
        album_path = unescape(album_match.group(1))
        album_url = urljoin(base_url, album_path)
        album_html = add_page_check(
            checks,
            name="album-detail",
            url=album_url,
            expected_status=200,
            marker='class="album-page"',
            expect_preview_noindex=args.expect_preview_noindex,
        )
        add_seo_check(
            checks,
            name="album-detail-seo",
            url=album_url,
            html=album_html,
            expected_canonical=urljoin("https://photos.kanouk.com", album_path),
            expected_jsonld="CollectionPage",
            require_og_image=True,
        )

        photo_match = re.search(r'href="(/p/[^"?#]+)"', album_html)
        if not photo_match:
            raise RuntimeError("no published photo found for SEO readback")
        photo_path = unescape(photo_match.group(1))
        photo_url = urljoin(base_url, photo_path)
        photo_html = add_page_check(
            checks,
            name="photo-detail",
            url=photo_url,
            expected_status=200,
            marker='class="photo-page"',
            expect_preview_noindex=args.expect_preview_noindex,
        )
        photo_seo = SeoParser()
        photo_seo.feed(photo_html)
        photo_jsonld = photo_seo.jsonld_types[0] if len(photo_seo.jsonld_types) == 1 else ""
        add_seo_check(
            checks,
            name="photo-detail-seo",
            url=photo_url,
            html=photo_html,
            expected_canonical=urljoin("https://photos.kanouk.com", photo_path),
            expected_jsonld=photo_jsonld if photo_jsonld in {"ImageObject", "VideoObject"} else "ImageObject",
            require_og_image=True,
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
        if parsed.hostname == "blog.kanouk.com":
            expected_sitemaps = ("sitemap-posts.xml", "sitemap-pages.xml")
        elif parsed.hostname == "photos.kanouk.com":
            expected_sitemaps = ("sitemap-albums.xml", "sitemap-photos.xml")
        else:
            expected_sitemaps = ("sitemap-posts.xml", "sitemap-albums.xml")
        for expected in expected_sitemaps:
            if expected not in sitemap_text:
                sitemap_failures.append(f"missing {expected}")
        if parsed.hostname == "photos.kanouk.com":
            photo_sitemap_status, _, photo_sitemap_body, _ = fetch(
                urljoin(base_url, "/sitemap-photos.xml")
            )
            photo_sitemap_text = photo_sitemap_body.decode("utf-8", errors="replace")
            if photo_sitemap_status != 200:
                sitemap_failures.append(
                    f"photo sitemap status={photo_sitemap_status}, expected=200"
                )
            if "https://photos.kanouk.com/p/" not in photo_sitemap_text:
                sitemap_failures.append("photo sitemap has no canonical /p/ URL")
            if "https://blog.kanouk.com/" in photo_sitemap_text:
                sitemap_failures.append("photo sitemap contains the blog origin")
            if "https://photos.kanouk.com/photos/" in photo_sitemap_text:
                sitemap_failures.append("photo sitemap contains the legacy /photos/ path")
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
