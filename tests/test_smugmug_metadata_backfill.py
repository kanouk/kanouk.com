from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/backfill_smugmug_metadata.py"
SPEC = importlib.util.spec_from_file_location("backfill_smugmug_metadata", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugMetadataBackfillTests(unittest.TestCase):
    def test_maps_smugmug_metadata_to_display_exif(self) -> None:
        exif, keywords = module.metadata_fields(
            {
                "ImageMetadata": {
                    "Make": " Apple ",
                    "Model": "iPhone 15 Pro",
                    "Lens": "iPhone 15 Pro back camera",
                    "Aperture": "2.8",
                    "Exposure": "1/125 sec",
                    "ISO": 80,
                    "FocalLength": "24.0 mm",
                    "ExposureCompensation": "+0.3 EV",
                    "Keywords": "Kyoto, station; night",
                }
            }
        )
        self.assertEqual(exif["Make"], "Apple")
        self.assertEqual(exif["FNumber"], 2.8)
        self.assertEqual(exif["ExposureTime"], 0.008)
        self.assertEqual(exif["FocalLength"], 24)
        self.assertEqual(exif["ExposureCompensation"], 0.3)
        self.assertEqual(keywords, ["Kyoto", "station", "night"])

    def test_ignores_empty_or_invalid_values(self) -> None:
        exif, keywords = module.metadata_fields(
            {"ImageMetadata": {"Make": " ", "Exposure": "unknown"}}
        )
        self.assertEqual(exif, {})
        self.assertEqual(keywords, [])


if __name__ == "__main__":
    unittest.main()
