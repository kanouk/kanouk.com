from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/verify_public_site.py"
SPEC = importlib.util.spec_from_file_location("verify_public_site", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class VerifyPublicSiteTests(unittest.TestCase):
    def test_seo_parser_collects_canonical_meta_and_jsonld(self) -> None:
        parser = module.SeoParser()
        parser.feed(
            '<link rel="canonical" href="https://photos.kanouk.com/p/example">'
            '<link rel="stylesheet preload" href="/_astro/theme.example.css">'
            '<meta property="og:title" content="Example">'
            '<meta property="og:image" content="https://photos.kanouk.com/media/example.jpg">'
            '<script type="application/ld+json">'
            '{"@context":"https://schema.org","@type":"ImageObject"}'
            '</script>'
        )
        self.assertEqual(
            parser.canonicals,
            ["https://photos.kanouk.com/p/example"],
        )
        self.assertEqual(parser.meta["og:title"], ["Example"])
        self.assertEqual(parser.jsonld_types, ["ImageObject"])
        self.assertEqual(parser.stylesheets, ["/_astro/theme.example.css"])

    def test_seo_parser_marks_invalid_jsonld(self) -> None:
        parser = module.SeoParser()
        parser.feed('<script type="application/ld+json">{broken}</script>')
        self.assertEqual(parser.jsonld_types, ["INVALID"])

    def test_responsive_media_url_uses_the_v2_fallback_image(self) -> None:
        html = (
            '<picture><source srcset="/_yohaku/media/preview-v2/320/avif/item.jpg 320w">'
            '<img src="/_yohaku/media/preview-v2/1200/webp/item.jpg"></picture>'
        )
        self.assertEqual(
            module.responsive_media_url(html),
            "/_yohaku/media/preview-v2/1200/webp/item.jpg",
        )

    def test_responsive_media_url_rejects_the_retired_v1_route(self) -> None:
        html = '<img src="/_yohaku/media/preview-v1/item.jpg">'
        self.assertIsNone(module.responsive_media_url(html))

    def test_stylesheet_contract_allows_plugin_css_without_theme_tokens(self) -> None:
        html = (
            '<link rel="stylesheet" href="/_astro/theme.css">'
            '<link rel="stylesheet" href="/_astro/plugin.css">'
        )
        responses = [
            (200, {"Content-Type": "text/css"}, b":root{--paper:#fff}" + b" " * 1024, 1),
            (200, {"Content-Type": "text/css"}, b".plugin{color:blue}" + b" " * 1024, 1),
        ]
        checks = []
        with patch.object(module, "fetch", side_effect=responses):
            module.add_stylesheet_check(checks, base_url="https://example.com/", html=html)
        self.assertTrue(all(check.ok for check in checks))
        self.assertEqual(checks[-1].name, "design-theme-contract")

    def test_stylesheet_contract_fails_when_no_css_has_theme_tokens(self) -> None:
        html = '<link rel="stylesheet" href="/_astro/plugin.css">'
        response = (200, {"Content-Type": "text/css"}, b".plugin{color:blue}" + b" " * 1024, 1)
        checks = []
        with patch.object(module, "fetch", return_value=response):
            module.add_stylesheet_check(checks, base_url="https://example.com/", html=html)
        self.assertTrue(checks[0].ok)
        self.assertFalse(checks[-1].ok)
        self.assertIn("missing", checks[-1].detail)


if __name__ == "__main__":
    unittest.main()
