from __future__ import annotations

import json
from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).parents[1]
WEB_ROOT = REPO_ROOT / "apps/web"


def load_jsonc(path: Path) -> dict[str, object]:
    source = re.sub(r"^\s*//.*$", "", path.read_text(), flags=re.MULTILINE)
    source = re.sub(r",\s*([}\]])", r"\1", source)
    return json.loads(source)


class YohakuDesignContractTests(unittest.TestCase):
    def test_blog_and_photos_are_declared_as_worker_custom_domains(self) -> None:
        config = load_jsonc(WEB_ROOT / "wrangler.jsonc")
        self.assertTrue(config.get("workers_dev"))
        self.assertTrue(config.get("preview_urls"))
        routes = config.get("routes")
        self.assertIsInstance(routes, list)
        self.assertEqual(
            routes,
            [
                {"pattern": "blog.kanouk.com", "custom_domain": True},
                {"pattern": "photos.kanouk.com", "custom_domain": True},
            ],
        )

    def test_ga4_continuity_is_limited_to_production_hosts(self) -> None:
        head = (WEB_ROOT / "src/components/YohakuHead.astro").read_text()
        self.assertIn('const GA4_MEASUREMENT_ID = "G-94EQ0WN7B9"', head)
        self.assertIn('["blog.kanouk.com", "photos.kanouk.com"]', head)
        self.assertIn("Astro.url.hostname", head)
        self.assertIn("googletagmanager.com/gtag/js", head)

    def test_pages_do_not_define_route_specific_style_systems(self) -> None:
        offenders = [
            str(path.relative_to(WEB_ROOT))
            for path in (WEB_ROOT / "src/pages").rglob("*.astro")
            if "<style" in path.read_text()
        ]
        self.assertEqual(offenders, [])

    def test_article_lead_and_body_share_one_reading_axis(self) -> None:
        css = (WEB_ROOT / "src/styles/theme.css").read_text()
        for selector in (".article-lead", ".article-main"):
            self.assertRegex(css, rf"{re.escape(selector)}\s*\{{[^}}]*grid-column:\s*1;")

    def test_image_lists_do_not_add_mechanical_rules_below_every_image(self) -> None:
        css = (WEB_ROOT / "src/styles/theme.css").read_text()
        album_copy = re.search(r"\.album-copy\s*\{([^}]*)\}", css)
        photo_copy = re.search(
            r"\.photo-card\s*>\s*span:not\(\.video-badge\)\s*\{([^}]*)\}",
            css,
        )
        self.assertIsNotNone(album_copy)
        self.assertIsNotNone(photo_copy)
        self.assertNotIn("border-top", album_copy.group(1))
        self.assertNotIn("border-top", photo_copy.group(1))

    def test_japanese_headings_disable_proportional_compression(self) -> None:
        css = (WEB_ROOT / "src/styles/theme.css").read_text()
        headings = re.search(r"h1, h2, h3, h4, h5, h6\s*\{([^}]*)\}", css)
        self.assertIsNotNone(headings)
        self.assertIn('font-feature-settings: "palt" 0', headings.group(1))
        self.assertIn("letter-spacing: 0.01em", headings.group(1))

    def test_cms_images_publish_a_css_aspect_ratio_before_decode(self) -> None:
        component = (WEB_ROOT / "src/components/YohakuImage.astro").read_text()
        css = (WEB_ROOT / "src/styles/theme.css").read_text()
        self.assertIn("const aspectRatio = width && height ? width / height", component)
        self.assertIn("--yohaku-image-ratio:${aspectRatio}", component)
        self.assertIn('class:list={["yohaku-image", className]}', component)
        self.assertIn("aspect-ratio: var(--yohaku-image-ratio, auto)", css)

    def test_japanese_font_hierarchy_uses_only_two_network_weights(self) -> None:
        config = (WEB_ROOT / "astro.config.mjs").read_text()
        noto = re.search(
            r'name:\s*"Noto Sans JP"(?P<body>.*?)(?:\n\s*\},)',
            config,
            re.DOTALL,
        )
        self.assertIsNotNone(noto)
        self.assertIn("weights: [400, 600]", noto.group("body"))

    def test_list_images_use_one_bounded_cloudflare_preview_preset(self) -> None:
        component = (WEB_ROOT / "src/components/YohakuImage.astro").read_text()
        worker = (WEB_ROOT / "src/worker.ts").read_text()
        self.assertIn("(preview || cropSafely) && !lowResolution && previewKey", component)
        self.assertIn("/_yohaku/media/preview-v1/", component)
        self.assertIn('const PREVIEW_PREFIX = "/_yohaku/media/preview-v1/"', worker)
        self.assertIn("const PREVIEW_WIDTH = 1200", worker)
        self.assertIn('format: "webp"', worker)
        self.assertIn('fit: "scale-down"', worker)
        self.assertIn('quality: 85', worker)

        portable = (WEB_ROOT / "src/components/YohakuPortableImage.astro").read_text()
        album_archive = (WEB_ROOT / "src/pages/albums/index.astro").read_text()
        album_detail = (WEB_ROOT / "src/pages/albums/[slug].astro").read_text()
        self.assertIn("<YohakuImage", portable)
        self.assertIn("preview", portable)
        self.assertIn("priority={index === 0}", album_archive)
        self.assertIn("preview priority={index === 0}", album_detail)

    def test_album_archive_bounds_cover_size_across_breakpoints(self) -> None:
        css = (WEB_ROOT / "src/styles/theme.css").read_text()
        album_grid = re.search(r"\.album-grid\s*\{([^}]*)\}", css)
        album_card = re.search(r"\.album-card\s*\{([^}]*)\}", css)
        self.assertIsNotNone(album_grid)
        self.assertIsNotNone(album_card)
        self.assertIn("repeat(3, minmax(0, 1fr))", album_grid.group(1))
        self.assertIn("max-width: 30rem", album_card.group(1))
        self.assertIn(
            '.album-card:hover .cover img:not([data-low-resolution="true"])',
            css,
        )
        self.assertRegex(
            css,
            r"@media \(max-width: 68rem\)[\s\S]*?\.album-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)",
        )
        self.assertRegex(
            css,
            r"@media \(max-width: 34rem\)[\s\S]*?\.album-grid\s*\{[^}]*grid-template-columns:\s*1fr",
        )

    def test_article_uses_one_reading_axis_without_duplicate_left_metadata(self) -> None:
        article = (WEB_ROOT / "src/pages/posts/[slug].astro").read_text()
        theme = (WEB_ROOT / "src/styles/theme.css").read_text()
        self.assertNotIn('class="article-meta-col"', article)
        self.assertIn('class="article-tags"', article)
        self.assertIn(".article-lead { grid-column: 1;", theme)
        self.assertIn(".article-main { grid-column: 1;", theme)

    def test_article_detail_uses_requested_content_order(self) -> None:
        article = (WEB_ROOT / "src/pages/posts/[slug].astro").read_text()
        theme = (WEB_ROOT / "src/styles/theme.css").read_text()
        title = article.index('class="article-title"')
        metadata = article.index('class="article-meta"')
        toc = article.index('class="toc article-toc"')
        body = article.index('class="article-content"')
        self.assertLess(title, metadata)
        self.assertLess(metadata, toc)
        self.assertLess(toc, body)
        self.assertNotIn('class="article-hero"', article)
        self.assertIn("word-break: auto-phrase", theme)
        self.assertIn('new Intl.Segmenter("ja", { granularity: "word" })', article)
        self.assertIn(".article-title__segment { white-space: nowrap; }", theme)

    def test_profile_and_kano_favicon_are_shared_across_blog_pages(self) -> None:
        base = (WEB_ROOT / "src/layouts/Base.astro").read_text()
        article = (WEB_ROOT / "src/pages/posts/[slug].astro").read_text()
        profile = (WEB_ROOT / "src/components/ProfileCard.astro").read_text()
        head = (WEB_ROOT / "src/components/YohakuHead.astro").read_text()
        self.assertIn("hasPageProfileSidebar", base)
        self.assertIn("<ProfileCard />", article)
        self.assertIn('src="/kano-profile.png"', profile)
        self.assertIn('href="/favicon.svg"', head)
        self.assertIn('href="/kano-profile.png"', head)

    def test_article_archive_selector_covers_the_full_migrated_history(self) -> None:
        archive_nav = (WEB_ROOT / "src/components/PostArchiveNav.astro").read_text()
        self.assertIn("getPostArchiveMonths(240)", archive_nav)
        self.assertIn(
            "selected={archive.year === selected.year && archive.month === selected.month}",
            archive_nav,
        )

    def test_semantic_quote_resets_the_generic_blockquote_frame(self) -> None:
        quote = (
            WEB_ROOT
            / "plugins/yohaku-content-blocks/src/astro/Quote.astro"
        ).read_text()
        components = (
            WEB_ROOT
            / "plugins/yohaku-content-blocks/src/astro/index.ts"
        ).read_text()
        self.assertIn('class="yohaku-quote__body"', quote)
        body = re.search(r"\.yohaku-quote__body\s*\{([^}]*)\}", quote)
        self.assertIsNotNone(body)
        self.assertIn("padding: 0", body.group(1))
        self.assertIn("border: 0", body.group(1))
        self.assertIn("font: inherit", body.group(1))
        self.assertIn('"yohaku.quote": Quote', components)


if __name__ == "__main__":
    unittest.main()
