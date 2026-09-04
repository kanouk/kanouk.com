import json
from pathlib import Path
import tempfile
import unittest

from scripts.migration.redact_photo_locations import load_allowlist, scrub_location, RedactionError


class PhotoLocationRedactionTests(unittest.TestCase):
    def test_scrub_location_removes_nested_location_only(self):
        value = {
            "camera": "X100",
            "latitude": 35.0,
            "exif": {"GPSLatitude": 35.0, "ISO": 200},
            "nested": [{"geotag": "secret", "caption": "keep"}],
        }
        self.assertEqual(scrub_location(value), {
            "camera": "X100",
            "exif": {"ISO": 200},
            "nested": [{"caption": "keep"}],
        })

    def test_allowlist_must_be_explicit_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "allowlist.json"
            path.write_text(json.dumps({"photo_ids": ["photo_12345678", "photo_12345678", "photo_87654321"]}))
            self.assertEqual(load_allowlist(path), ["photo_12345678", "photo_87654321"])

    def test_empty_allowlist_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "allowlist.json"
            path.write_text('{"photo_ids": []}')
            with self.assertRaises(RedactionError):
                load_allowlist(path)
