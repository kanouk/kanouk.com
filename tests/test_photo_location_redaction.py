import json
from pathlib import Path
import tempfile
import unittest

from scripts.migration.redact_photo_locations import (
    RedactionError,
    load_allowlist,
    scrub_location,
    write_receipt,
)


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

    def test_receipt_is_written_beside_allowlist_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            allowlist = Path(directory) / "approved.json"
            allowlist.write_text('{"photo_ids":["photo_12345678"]}')
            payload = {"apply": True, "results": [{"photo_id": "photo_12345678"}]}
            first = write_receipt(allowlist, payload)
            second = write_receipt(allowlist, payload)
            self.assertNotEqual(first, second)
            self.assertEqual(json.loads(first.read_text()), payload)
            self.assertEqual(first.stat().st_mode & 0o777, 0o600)
