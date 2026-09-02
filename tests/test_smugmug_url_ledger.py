from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT_ROOT = Path(__file__).parents[1] / "scripts/migration"
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))
SPEC = importlib.util.spec_from_file_location(
    "build_smugmug_url_ledger", SCRIPT_ROOT / "build_smugmug_url_ledger.py"
)
assert SPEC and SPEC.loader
ledger_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger_module)


class SmugMugUrlLedgerTests(unittest.TestCase):
    def test_maps_page_and_image_urls_for_one_asset(self) -> None:
        manifest = {
            "assets": [
                {
                    "id": "kph_stable",
                    "position": 1,
                    "source": {"image_key": "abc123"},
                    "destination": {
                        "photo_path": "/photos/kph_stable",
                        "media_path": "/media/kph_stable",
                    },
                }
            ]
        }
        article = (
            "[![](https://photos.smugmug.com/album/i-abc123/0/hash/M/photo.jpg)]"
            "(https://kanolog.smugmug.com/album/i-abc123/A)"
        )
        ledger, transformed = ledger_module.build(
            manifest,
            article,
            article_id="8664",
            article_url="https://kanolog.net/stream/8664",
            destination_origin="https://photos.kanouk.com",
        )
        self.assertEqual(ledger["unique_assets"], 1)
        self.assertEqual(ledger["source_url_occurrences"], 2)
        self.assertEqual(ledger["replacement_occurrences"], 2)
        self.assertEqual(ledger["remaining_smugmug_urls_after_dry_run"], [])
        self.assertIn("https://photos.kanouk.com/media/kph_stable", transformed)
        self.assertIn("https://photos.kanouk.com/p/kph_stable", transformed)

    def test_reports_unmatched_source_url(self) -> None:
        ledger, _ = ledger_module.build(
            {"assets": []},
            "https://kanolog.smugmug.com/album/i-missing/A",
            article_id="1",
            article_url="https://example.com/1",
            destination_origin="https://photos.kanouk.com",
        )
        self.assertEqual(len(ledger["unmatched_urls"]), 1)


if __name__ == "__main__":
    unittest.main()
