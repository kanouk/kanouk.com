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
        routes = config.get("routes")
        self.assertIsInstance(routes, list)
        self.assertEqual(
            routes,
            [
                {"pattern": "blog.kanouk.com", "custom_domain": True},
                {"pattern": "photos.kanouk.com", "custom_domain": True},
            ],
        )

    def test_pages_do_not_define_route_specific_style_systems(self) -> None:
        offenders = [
            str(path.relative_to(WEB_ROOT))
            for path in (WEB_ROOT / "src/pages").rglob("*.astro")
            if "<style" in path.read_text()
        ]
        self.assertEqual(offenders, [])

    def test_article_lead_hero_and_body_share_one_reading_axis(self) -> None:
        css = (WEB_ROOT / "src/styles/theme.css").read_text()
        for selector in (".article-lead", ".article-hero", ".article-main"):
            self.assertRegex(css, rf"{re.escape(selector)}\s*\{{[^}}]*grid-column:\s*2;")

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


if __name__ == "__main__":
    unittest.main()
