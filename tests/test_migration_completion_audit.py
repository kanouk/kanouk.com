from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = (
    Path(__file__).parents[1] / "scripts/migration/audit_migration_completion.py"
)
SPEC = importlib.util.spec_from_file_location("audit_migration_completion", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def write_json(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value))
    return path


class MigrationCompletionAuditTests(unittest.TestCase):
    def test_owner_auth_pending_keeps_cutover_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            conversion = write_json(
                root / "conversion.json",
                {
                    "totals": {
                        "posts": 1847,
                        "pages": 7,
                        "convertedBlocks": 17055,
                        "htmlBlocks": 0,
                    }
                },
            )
            media = write_json(
                root / "media.json",
                {"total_available": 2028, "counts": {"verified": 2028}},
            )
            content_import = write_json(
                root / "import.json",
                {
                    "counts": {
                        "selected": 1854,
                        "failed": 0,
                        "results": {"skipped_verified": 1854},
                    }
                },
            )
            manifest = write_json(
                root / "album.json",
                {
                    "album": {
                        "slug": "sample",
                        "asset_count": 1,
                        "source": {"album_key": "key"},
                        "destination": {"emdash_content_id": "album-id"},
                    },
                    "assets": [
                        {
                            "id": "photo-id",
                            "kind": "image",
                            "source": {"format": "JPG"},
                            "destination": {},
                            "verification": {
                                "migration_status": "pending_owner_auth"
                            },
                        }
                    ],
                },
            )
            catalog = write_json(
                root / "catalog.json", {"albums": [{"manifest": manifest.name}]}
            )
            audit = module.build_audit(
                conversion_path=conversion,
                wordpress_media_path=media,
                wordpress_import_path=content_import,
                smugmug_catalog_path=catalog,
            )

        self.assertTrue(audit["wordpress"]["complete"])
        self.assertFalse(audit["smugmug"]["complete"])
        self.assertFalse(audit["gates"]["cutover_ready"])
        self.assertEqual(audit["blockers"][0]["assets"], 1)
        self.assertEqual(audit["blockers"][0]["albums"][0]["slug"], "sample")

    def test_all_verified_data_needs_backup_and_public_audit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            conversion = write_json(
                root / "conversion.json",
                {
                    "totals": {
                        "posts": 1847,
                        "pages": 7,
                        "convertedBlocks": 17050,
                        "htmlBlocks": 0,
                    }
                },
            )
            media = write_json(
                root / "media.json",
                {"total_available": 2028, "counts": {"verified": 2028}},
            )
            content_import = write_json(
                root / "import.json",
                {
                    "counts": {
                        "selected": 1854,
                        "failed": 0,
                        "results": {"skipped_verified": 1854},
                    }
                },
            )
            manifest = write_json(
                root / "album.json",
                {
                    "album": {
                        "slug": "sample",
                        "asset_count": 1,
                        "source": {"album_key": "key"},
                        "destination": {"emdash_content_id": "album-id"},
                    },
                    "assets": [
                        {
                            "id": "photo-id",
                            "kind": "image",
                            "source": {"format": "JPG"},
                            "destination": {
                                "emdash_content_id": "content-id",
                                "r2_object_key": "photo.jpg",
                            },
                            "verification": {
                                "r2_roundtrip_verified": True,
                                "sha256": "abc",
                            },
                        }
                    ],
                },
            )
            catalog = write_json(
                root / "catalog.json", {"albums": [{"manifest": manifest.name}]}
            )
            audit = module.build_audit(
                conversion_path=conversion,
                wordpress_media_path=media,
                wordpress_import_path=content_import,
                smugmug_catalog_path=catalog,
            )

        self.assertEqual(audit["blockers"], [])
        self.assertTrue(audit["gates"]["data_migration_complete"])
        self.assertFalse(audit["gates"]["cutover_ready"])
        self.assertFalse(audit["complete"])

    def test_final_backup_and_public_audit_open_cutover_gate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            conversion = write_json(
                root / "conversion.json",
                {
                    "totals": {
                        "posts": 1847,
                        "pages": 7,
                        "convertedBlocks": 17050,
                        "htmlBlocks": 0,
                    }
                },
            )
            media = write_json(
                root / "media.json",
                {"total_available": 2028, "counts": {"verified": 2028}},
            )
            content_import = write_json(
                root / "import.json",
                {
                    "counts": {
                        "selected": 1854,
                        "failed": 0,
                        "results": {"skipped_verified": 1854},
                    }
                },
            )
            manifest = write_json(
                root / "album.json",
                {
                    "album": {
                        "slug": "sample",
                        "asset_count": 1,
                        "source": {"album_key": "key"},
                        "destination": {"emdash_content_id": "album-id"},
                    },
                    "assets": [
                        {
                            "id": "photo-id",
                            "kind": "image",
                            "source": {"format": "JPG"},
                            "destination": {
                                "emdash_content_id": "content-id",
                                "r2_object_key": "photo.jpg",
                            },
                            "verification": {
                                "r2_roundtrip_verified": True,
                                "sha256": "abc",
                            },
                        }
                    ],
                },
            )
            catalog = write_json(
                root / "catalog.json", {"albums": [{"manifest": manifest.name}]}
            )
            backup_manifest = write_json(
                root / "backup.json",
                {
                    "source": "https://example.test",
                    "database": "test",
                    "d1": {"sha256": "abc"},
                    "media_count": 1,
                    "media_total_bytes": 42,
                    "r2_object_count": 2,
                    "r2_total_bytes": 52,
                    "untracked_r2_count": 1,
                    "untracked_r2_total_bytes": 10,
                },
            )
            backup_verification = write_json(
                root / "backup-verification.json",
                {
                    "verified": True,
                    "media_count": 1,
                    "media_total_bytes": 42,
                    "r2_object_count": 2,
                    "r2_total_bytes": 52,
                    "untracked_r2_count": 1,
                    "untracked_r2_total_bytes": 10,
                    "d1_integrity": "ok",
                    "d1_foreign_key_violations": 0,
                },
            )
            public_audit = write_json(
                root / "public-audit.json",
                {
                    "verified": True,
                    "base_url": "https://example.test",
                    "public_pages": 10,
                    "internal_links": 20,
                    "forbidden_counts": {"smugmug": 0},
                    "allowed_smugmug_ids": [],
                    "failure_count": 0,
                },
            )
            audit = module.build_audit(
                conversion_path=conversion,
                wordpress_media_path=media,
                wordpress_import_path=content_import,
                smugmug_catalog_path=catalog,
                backup_manifest_path=backup_manifest,
                backup_verification_path=backup_verification,
                public_audit_path=public_audit,
                dns_change_authorized=True,
            )

        self.assertTrue(audit["gates"]["backup_restore_verified"])
        self.assertTrue(audit["gates"]["final_public_audit_verified"])
        self.assertTrue(audit["gates"]["dns_change_authorized"])
        self.assertTrue(audit["gates"]["cutover_ready"])
        self.assertTrue(audit["complete"])


if __name__ == "__main__":
    unittest.main()
