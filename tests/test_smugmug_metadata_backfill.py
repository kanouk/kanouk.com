from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


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

    def test_retries_version_conflict_with_fresh_revision(self) -> None:
        reads = iter(
            [
                {"_rev": "rev-1", "data": {"source_metadata": {}}},
                {"_rev": "rev-2", "data": {"source_metadata": {}}},
                {
                    "_rev": "rev-3",
                    "data": {
                        "source_metadata": {
                            "exif": {"Make": "Apple"},
                            "keywords": None,
                        }
                    },
                },
            ]
        )
        put_revisions: list[str] = []

        def fake_request(method, path, token, payload=None):
            if method == "PUT":
                put_revisions.append(payload["_rev"])
                if len(put_revisions) == 1:
                    raise RuntimeError("EmDash HTTP 409: version conflict")
                return {"item": {"draftRevisionId": None}}
            raise AssertionError(f"unexpected request: {method} {path}")

        with (
            patch.object(module, "get_photo", side_effect=lambda *_: next(reads)),
            patch.object(module, "emdash_request", side_effect=fake_request),
            patch.object(module.time, "sleep"),
        ):
            changed = module.update_photo(
                {"id": "photo-1", "destination": {"emdash_content_id": "photo-1"}},
                {"ImageMetadata": {"Make": "Apple"}},
                env={},
                token="token",
            )

        self.assertTrue(changed)
        self.assertEqual(put_revisions, ["rev-1", "rev-2"])


if __name__ == "__main__":
    unittest.main()
