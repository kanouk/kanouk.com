from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


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
            '<link rel="canonical" href="https://photos.kanouk.com/photos/example">'
            '<meta property="og:title" content="Example">'
            '<meta property="og:image" content="https://photos.kanouk.com/media/example.jpg">'
            '<script type="application/ld+json">'
            '{"@context":"https://schema.org","@type":"ImageObject"}'
            '</script>'
        )
        self.assertEqual(
            parser.canonicals,
            ["https://photos.kanouk.com/photos/example"],
        )
        self.assertEqual(parser.meta["og:title"], ["Example"])
        self.assertEqual(parser.jsonld_types, ["ImageObject"])

    def test_seo_parser_marks_invalid_jsonld(self) -> None:
        parser = module.SeoParser()
        parser.feed('<script type="application/ld+json">{broken}</script>')
        self.assertEqual(parser.jsonld_types, ["INVALID"])


if __name__ == "__main__":
    unittest.main()
