from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT_ROOT = Path(__file__).parents[1] / "scripts/migration"
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))
SPEC = importlib.util.spec_from_file_location(
    "record_smugmug_public_derivative",
    SCRIPT_ROOT / "record_smugmug_public_derivative.py",
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugPublicAssetTests(unittest.TestCase):
    def manifest(self) -> dict:
        return {
            "album": {"destination": {"emdash_content_id": None}},
            "assets": [
                {
                    "id": "kph_test",
                    "destination": {
                        "emdash_content_id": None,
                        "emdash_media_id": None,
                        "r2_object_key": None,
                    },
                    "verification": {},
                }
            ]
        }

    def test_records_matching_gps_without_persisting_coordinates(self) -> None:
        asset = module.record(
            self.manifest(),
            asset_id="kph_test",
            emdash_album_content_id="album-id",
            emdash_photo_content_id="photo-id",
            emdash_media_id="media-id",
            storage_key="object.jpg",
            derivative_sha256="sha",
            derivative_bytes=10,
            source_metadata={"latitude": 35.0, "longitude": 135.0},
            public_metadata={
                "latitude": 35.0,
                "longitude": 135.0,
                "icc_profile": "sRGB",
            },
        )
        self.assertEqual(asset["destination"]["emdash_media_id"], "media-id")
        self.assertEqual(asset["destination"]["emdash_content_id"], "photo-id")
        public_asset = asset["verification"]["public_asset"]
        self.assertTrue(public_asset["gps_present"])
        self.assertTrue(public_asset["gps_preserved"])
        self.assertNotIn("latitude", public_asset)
        self.assertNotIn("longitude", public_asset)

    def test_rejects_removed_gps_metadata(self) -> None:
        with self.assertRaisesRegex(ValueError, "GPS"):
            module.record(
                self.manifest(),
                asset_id="kph_test",
                emdash_album_content_id="album-id",
                emdash_photo_content_id="photo-id",
                emdash_media_id="media-id",
                storage_key="object.jpg",
                derivative_sha256="sha",
                derivative_bytes=10,
                source_metadata={"latitude": 35.0, "longitude": 135.0},
                public_metadata={"latitude": None, "longitude": None},
            )

    def test_accepts_source_without_gps_when_public_is_also_without_gps(self) -> None:
        asset = module.record(
            self.manifest(),
            asset_id="kph_test",
            emdash_album_content_id="album-id",
            emdash_photo_content_id="photo-id",
            emdash_media_id="media-id",
            storage_key="object.jpg",
            derivative_sha256="sha",
            derivative_bytes=10,
            source_metadata={"latitude": None, "longitude": None},
            public_metadata={"latitude": None, "longitude": None},
        )
        self.assertFalse(asset["verification"]["public_asset"]["gps_present"])


if __name__ == "__main__":
    unittest.main()
