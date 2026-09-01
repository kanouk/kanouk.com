from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = (
    Path(__file__).parents[1]
    / "scripts/migration/resume_smugmug_owner_migration.py"
)
SPEC = importlib.util.spec_from_file_location("resume_smugmug_owner_migration", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugOwnerResumeTests(unittest.TestCase):
    def test_owner_credential_state_is_fail_closed(self) -> None:
        self.assertEqual(module.owner_credential_state({}), "missing")
        self.assertEqual(
            module.owner_credential_state({"SMUGMUG_ACCESS_TOKEN": "token"}),
            "incomplete",
        )
        self.assertEqual(
            module.owner_credential_state(
                {
                    "SMUGMUG_API_SECRET": "secret",
                    "SMUGMUG_ACCESS_TOKEN": "token",
                    "SMUGMUG_ACCESS_TOKEN_SECRET": "token-secret",
                }
            ),
            "ready",
        )

    def test_selects_only_albums_with_owner_auth_pending_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "one.json").write_text(
                json.dumps(
                    {
                        "assets": [
                            {
                                "verification": {
                                    "migration_status": "pending_owner_auth"
                                }
                            },
                            {"verification": {"r2_roundtrip_verified": True}},
                        ]
                    }
                )
            )
            (root / "two.json").write_text(
                json.dumps(
                    {"assets": [{"verification": {"r2_roundtrip_verified": True}}]}
                )
            )
            catalog_path = root / "catalog.json"
            catalog_path.write_text(
                json.dumps(
                    {
                        "albums": [
                            {"manifest": "one.json", "source_album_key": "one"},
                            {"manifest": "two.json", "source_album_key": "two"},
                        ]
                    }
                )
            )
            rows, count = module.pending_owner_rows(catalog_path)

        self.assertEqual(count, 1)
        self.assertEqual([row["source_album_key"] for row in rows], ["one"])

    def test_builds_scoped_catalog_command(self) -> None:
        command = module.migration_command(
            Path("/tmp/catalog.json"),
            [{"source_album_key": "one"}, {"source_album_key": "two"}],
            concurrency=3,
        )
        self.assertIn("--apply", command)
        self.assertEqual(command.count("--include-album-key"), 2)
        self.assertEqual(
            command[-4:],
            ["--include-album-key", "one", "--include-album-key", "two"],
        )


if __name__ == "__main__":
    unittest.main()
