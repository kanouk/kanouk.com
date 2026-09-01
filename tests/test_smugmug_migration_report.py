from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts/migration/report_smugmug_migration.py"
SPEC = importlib.util.spec_from_file_location("report_smugmug_migration", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugMigrationReportTests(unittest.TestCase):
    def test_report_distinguishes_verified_and_owner_auth_pending(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {
                "album": {
                    "slug": "sample",
                    "asset_count": 2,
                    "source": {"album_key": "key"},
                    "destination": {"emdash_content_id": "album-id"},
                },
                "assets": [
                    {
                        "id": "one",
                        "kind": "image",
                        "source": {"format": "JPG"},
                        "destination": {
                            "emdash_content_id": "content-id",
                            "r2_object_key": "one.jpg",
                        },
                        "verification": {
                            "r2_roundtrip_verified": True,
                            "sha256": "abc",
                        },
                    },
                    {
                        "id": "two",
                        "kind": "video",
                        "source": {"format": "MP4"},
                        "destination": {},
                        "verification": {"migration_status": "pending_owner_auth"},
                    },
                ],
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            catalog = {"albums": [{"manifest": "manifest.json"}]}
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps(catalog))
            report = module.build_report(catalog_path)

        self.assertEqual(report["statuses"], {"pending_owner_auth": 1, "verified": 1})
        self.assertEqual(report["kinds"], {"image": 1, "video": 1})
        self.assertFalse(report["complete"])
        self.assertEqual(report["manifest_mismatches"], [])


if __name__ == "__main__":
    unittest.main()
