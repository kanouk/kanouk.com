from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/run_wordpress_readonly.py"
SPEC = importlib.util.spec_from_file_location("run_wordpress_readonly", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class WordPressSecretRunnerTests(unittest.TestCase):
    def credential_file(self, directory: str, site: str = "https://kanolog.net") -> Path:
        path = Path(directory) / "WordPress-kanolog.md"
        path.write_text(
            f"- Site URL: `{site}`\n"
            "- Username: `user`\n"
            "- Application Password: `password`\n"
        )
        return path

    def test_loads_pinned_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            credential = runner.load_credential(self.credential_file(directory))
        self.assertEqual(credential["site"], "https://kanolog.net")

    def test_rejects_wrong_source_host(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(runner.WordPressCredentialError, "kanolog.net"):
                runner.load_credential(
                    self.credential_file(directory, "https://example.test")
                )

    def test_injects_site_and_blocks_override(self) -> None:
        credential = {
            "site": "https://kanolog.net",
            "username": "user",
            "password": "password",
        }
        command = runner.normalized_command(
            ["audit_wordpress.py", "rest"], credential
        )
        self.assertEqual(command[-2:], ["--site", "https://kanolog.net"])
        with self.assertRaisesRegex(runner.WordPressCredentialError, "override"):
            runner.normalized_command(
                ["audit_wordpress.py", "rest", "--site", "https://example.test"],
                credential,
            )


if __name__ == "__main__":
    unittest.main()
