from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = (
    Path(__file__).parents[1] / "scripts/migration/run_smugmug_readonly.py"
)
SPEC = importlib.util.spec_from_file_location("run_smugmug_readonly", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class SmugMugCredentialTests(unittest.TestCase):
    def test_loads_configured_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SmugMug.md"
            path.write_text("API Key: `public-api-key`\nAPI Secret: `secret`\n")
            self.assertEqual(runner.load_api_key(path), "public-api-key")

    def test_rejects_missing_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SmugMug.md"
            path.write_text("API Secret: `secret`\n")
            with self.assertRaisesRegex(
                runner.SmugMugCredentialError, "no configured API Key"
            ):
                runner.load_api_key(path)

    def test_overrides_existing_environment_key(self) -> None:
        env = runner.child_environment(
            "expected", {"PATH": "/bin", "SMUGMUG_API_KEY": "wrong"}
        )
        self.assertEqual(env["SMUGMUG_API_KEY"], "expected")

    def test_api_secret_alone_keeps_public_mode(self) -> None:
        env = runner.child_environment(
            {"API Key": "key", "API Secret": "secret"},
            {"SMUGMUG_API_SECRET": "stale", "SMUGMUG_ACCESS_TOKEN": "stale"},
        )
        self.assertNotIn("SMUGMUG_API_SECRET", env)
        self.assertNotIn("SMUGMUG_ACCESS_TOKEN", env)

    def test_loads_complete_owner_credentials_without_printing_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SmugMug.md"
            path.write_text(
                "API Key: `key`\nAPI Secret: `secret`\n"
                "Access Token: `token`\nAccess Token Secret: `token-secret`\n"
            )
            credentials = runner.load_credentials(path)
            env = runner.child_environment(credentials, {"PATH": "/bin"})
        self.assertEqual(env["SMUGMUG_API_SECRET"], "secret")
        self.assertEqual(env["SMUGMUG_ACCESS_TOKEN"], "token")
        self.assertEqual(env["SMUGMUG_ACCESS_TOKEN_SECRET"], "token-secret")

    def test_rejects_partial_owner_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SmugMug.md"
            path.write_text("API Key: `key`\nAccess Token: `token`\n")
            with self.assertRaisesRegex(
                runner.SmugMugCredentialError, "incomplete owner credentials"
            ):
                runner.load_credentials(path)

    def test_cover_apply_without_refresh_does_not_need_smugmug_credentials(self) -> None:
        self.assertFalse(
            runner.requires_smugmug_credentials(
                [
                    "apply_smugmug_album_covers.py",
                    "--catalog",
                    "migration/smugmug/catalog.json",
                    "--apply",
                ]
            )
        )
        self.assertTrue(
            runner.requires_smugmug_credentials(
                [
                    "apply_smugmug_album_covers.py",
                    "--catalog",
                    "migration/smugmug/catalog.json",
                    "--refresh-from-smugmug",
                    "--apply",
                ]
            )
        )
        self.assertTrue(
            runner.requires_smugmug_credentials(["audit_smugmug.py", "--help"])
        )

    def test_cover_apply_does_not_open_smugmug_vault(self) -> None:
        with (
            patch.object(runner, "load_credentials") as load,
            patch.object(
                runner.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0),
            ) as run,
        ):
            code = runner.main(
                [
                    "apply_smugmug_album_covers.py",
                    "--catalog",
                    "migration/smugmug/catalog.json",
                    "--apply",
                ]
            )
        self.assertEqual(code, 0)
        load.assert_not_called()
        run.assert_called_once()

    def test_only_allows_read_only_scripts(self) -> None:
        command = runner.normalized_command(["audit_smugmug.py", "--help"])
        self.assertEqual(Path(command[1]).name, "audit_smugmug.py")
        command = runner.normalized_command(["apply_smugmug_album_covers.py", "--help"])
        self.assertEqual(Path(command[1]).name, "apply_smugmug_album_covers.py")
        with self.assertRaisesRegex(
            runner.SmugMugCredentialError, "allowlisted script"
        ):
            runner.normalized_command(["../something.py"])


if __name__ == "__main__":
    unittest.main()
