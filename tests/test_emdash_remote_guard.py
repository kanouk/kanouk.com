from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/cloudflare/run_emdash_kanouk.py"
SPEC = importlib.util.spec_from_file_location("run_emdash_kanouk", MODULE_PATH)
assert SPEC and SPEC.loader
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def credential_text(email: str, url: str, token: str) -> str:
    return f"""# EmDash

- Admin Email: `{email}`
- URL: `{url}`
- Token: `{token}`
"""


class EmDashRemoteGuardTests(unittest.TestCase):
    def test_loads_expected_staging_credential(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(
                credential_text(guard.EXPECTED_EMAIL, guard.EXPECTED_URL, "ec_pat_valid")
            )
            self.assertEqual(guard.load_credential(path)["email"], guard.EXPECTED_EMAIL)

    def test_rejects_other_email_and_url(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(
                credential_text(
                    "fragrance.radio@gmail.com", "https://other.example", "ec_pat_valid"
                )
            )
            with self.assertRaisesRegex(guard.EmDashGuardError, "Admin Email"):
                guard.load_credential(path)

    def test_environment_overrides_ambient_credential(self) -> None:
        env = guard.child_environment(
            {"token": "ec_pat_expected", "url": guard.EXPECTED_URL},
            {"PATH": "/bin", "EMDASH_TOKEN": "wrong", "EMDASH_URL": "wrong"},
        )
        self.assertEqual(env["EMDASH_TOKEN"], "ec_pat_expected")
        self.assertEqual(env["EMDASH_URL"], guard.EXPECTED_URL)

    def test_only_allows_bounded_remote_commands(self) -> None:
        self.assertEqual(guard.normalized_args(["media", "list"]), ["media", "list"])
        for command in ("login", "logout", "seed", "migrate"):
            with self.subTest(command=command):
                with self.assertRaisesRegex(guard.EmDashGuardError, "allowlisted"):
                    guard.normalized_args([command])
        with self.assertRaisesRegex(guard.EmDashGuardError, "URL overrides"):
            guard.normalized_args(["media", "list", "--url", "https://other.example"])

    def test_store_token_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            guard.store_token("ec_pat_" + "a" * 32, path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(guard.EmDashGuardError, "already exists"):
                guard.store_token("ec_pat_" + "b" * 32, path)

    def test_validates_pinned_schema(self) -> None:
        guard.validate_schema_preflight(
            {"data": [{"slug": "albums"}, {"slug": "photos"}, {"slug": "posts"}]}
        )
        with self.assertRaisesRegex(guard.EmDashGuardError, "missing"):
            guard.validate_schema_preflight({"data": [{"slug": "posts"}]})


if __name__ == "__main__":
    unittest.main()
