from __future__ import annotations

import importlib.util
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT_ROOT = Path(__file__).parents[1] / "scripts/migration"
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))


def load(name: str):
    path = SCRIPT_ROOT / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


downloader = load("download_smugmug_pilot_asset")
roundtrip = load("record_smugmug_r2_roundtrip")


class SmugMugPilotRoundtripTests(unittest.TestCase):
    def test_copy_and_hash(self) -> None:
        destination = BytesIO()
        hashes = downloader.copy_and_hash(BytesIO(b"pilot-bytes"), destination)
        self.assertEqual(destination.getvalue(), b"pilot-bytes")
        self.assertEqual(hashes["bytes"], 11)
        self.assertEqual(len(hashes["md5"]), 32)
        self.assertEqual(len(hashes["sha256"]), 64)

    def test_records_verified_roundtrip(self) -> None:
        manifest = {
            "assets": [
                {
                    "id": "kph_test",
                    "source": {"archived_md5": "source-md5"},
                    "destination": {"r2_object_key": None},
                    "verification": {},
                }
            ]
        }
        receipt = {
            "asset_id": "kph_test",
            "md5": "source-md5",
            "sha256": "source-sha256",
        }
        asset = roundtrip.record(
            manifest,
            receipt,
            r2_object_key="smugmug/pilot.jpg",
            r2_download_sha256="source-sha256",
        )
        self.assertTrue(asset["verification"]["r2_roundtrip_verified"])
        self.assertEqual(asset["destination"]["r2_object_key"], "smugmug/pilot.jpg")

    def test_original_exif_summary_does_not_persist_coordinates(self) -> None:
        # A non-image exercises the safe fallback without adding an EXIF fixture.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "not-an-image"
            path.write_bytes(b"not an image")
            summary = downloader.original_exif_summary(path)
        self.assertEqual(set(summary), {"captured_at", "offset", "gps_present"})
        self.assertNotIn("latitude", str(summary).lower())
        self.assertNotIn("longitude", str(summary).lower())

    def test_rejects_mismatched_r2_download(self) -> None:
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            roundtrip.record(
                {"assets": []},
                {"sha256": "expected"},
                r2_object_key="object",
                r2_download_sha256="different",
            )

    def test_records_deleted_probe_without_destination_key(self) -> None:
        manifest = {
            "assets": [
                {
                    "id": "kph_test",
                    "source": {"archived_md5": "source-md5"},
                    "destination": {"r2_object_key": None},
                    "verification": {},
                }
            ]
        }
        asset = roundtrip.record(
            manifest,
            {"asset_id": "kph_test", "md5": "source-md5", "sha256": "sha"},
            r2_object_key="pilots/source-probe.jpg",
            r2_download_sha256="sha",
            probe_deleted_after_verification=True,
        )
        self.assertIsNone(asset["destination"]["r2_object_key"])
        self.assertTrue(asset["verification"]["r2_probe"]["deleted_after_verification"])


if __name__ == "__main__":
    unittest.main()
