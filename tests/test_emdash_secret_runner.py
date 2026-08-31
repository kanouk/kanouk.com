from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = (
    Path(__file__).parents[1] / "scripts/cloudflare/run_emdash_local.py"
)
SPEC = importlib.util.spec_from_file_location("run_emdash_local", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class EmDashSecretTests(unittest.TestCase):
    valid_key = "emdash_enc_v1_" + ("a" * 43)

    def test_loads_configured_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(f"- EmDash Encryption Key: `{self.valid_key}`\n")
            self.assertEqual(runner.load_emdash_key(path), self.valid_key)

    def test_rejects_placeholder(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(
                "- EmDash Encryption Key: `REPLACE_WITH_EMDASH_ENCRYPTION_KEY`\n"
            )
            with self.assertRaisesRegex(runner.SecretError, "no configured"):
                runner.load_emdash_key(path)

    def test_rejects_unexpected_format(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text("- EmDash Encryption Key: `not-an-emdash-key`\n")
            with self.assertRaisesRegex(runner.SecretError, "unexpected format"):
                runner.load_emdash_key(path)

    def test_child_environment_overrides_existing_key(self) -> None:
        env = runner.child_environment(
            self.valid_key, {"PATH": "/bin", "EMDASH_ENCRYPTION_KEY": "wrong"}
        )
        self.assertEqual(env["EMDASH_ENCRYPTION_KEY"], self.valid_key)


if __name__ == "__main__":
    unittest.main()
