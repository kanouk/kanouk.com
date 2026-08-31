from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/build_smugmug_catalog.py"
SPEC = importlib.util.spec_from_file_location("build_smugmug_catalog", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugCatalogTests(unittest.TestCase):
    def test_uses_public_uri_tail_for_human_slug(self) -> None:
        self.assertEqual(
            module.album_slug(
                {"AlbumKey": "abc", "WebUri": "https://example.test/2024-06-Kyoto"}
            ),
            "2024-06-kyoto",
        )

    def test_prefers_dated_public_title(self) -> None:
        self.assertEqual(
            module.album_slug(
                {
                    "AlbumKey": "abc",
                    "Title": "Nara/Kyoto, 2021/03",
                    "WebUri": "https://example.test/20210309NaraKyoto",
                }
            ),
            "2021-03-nara-kyoto",
        )

    def test_slug_is_safe_and_bounded(self) -> None:
        slug = module.slugify(" 東京 旅行 / Summer 2024 ", "abc")
        self.assertEqual(slug, "summer-2024")
        self.assertLessEqual(len(module.slugify("a" * 100, "abc")), 72)

    def test_duplicate_slug_gets_stable_suffix(self) -> None:
        used: set[str] = set()
        self.assertEqual(module.unique_slug("album", "one", used), "album")
        duplicate = module.unique_slug("album", "two", used)
        self.assertRegex(duplicate, r"^album-[0-9a-f]{8}$")


if __name__ == "__main__":
    unittest.main()
