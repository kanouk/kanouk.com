from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPT_ROOT = Path(__file__).parents[1] / "scripts/migration"
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))
SPEC = importlib.util.spec_from_file_location(
    "apply_smugmug_pilot_gps",
    SCRIPT_ROOT / "apply_smugmug_pilot_gps.py",
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugPilotGpsTests(unittest.TestCase):
    def test_validates_location_and_optional_altitude(self) -> None:
        location = module.validated_location(
            {"GPSLatitude": 35.0, "GPSLongitude": 135.0, "GPSAltitude": 42}
        )
        self.assertEqual(location["latitude"], 35.0)
        self.assertEqual(location["longitude"], 135.0)
        self.assertEqual(location["altitude"], 42.0)

    def test_rejects_invalid_location(self) -> None:
        with self.assertRaisesRegex(module.PilotGpsError, "latitude"):
            module.validated_location(
                {"GPSLatitude": 91.0, "GPSLongitude": 135.0}
            )

    def test_patch_keeps_coordinates_out_of_source_metadata(self) -> None:
        patch = module.content_patch(
            {"title": "Photo", "alt": "Alt", "source_metadata": {"pilot": True}},
            media_id="media-id",
            location={"latitude": 35.0, "longitude": 135.0, "altitude": None},
            source_sha256="sha",
        )
        self.assertEqual(patch["image"], {"id": "media-id", "provider": "local", "alt": "Alt"})
        self.assertEqual(patch["latitude"], 35.0)
        self.assertNotIn("latitude", patch["source_metadata"])
        self.assertNotIn("longitude", patch["source_metadata"])
        self.assertTrue(patch["source_metadata"]["gps_exif_preserved"])


if __name__ == "__main__":
    unittest.main()
