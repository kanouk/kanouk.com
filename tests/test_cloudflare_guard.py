from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = (
    Path(__file__).parents[1] / "scripts/cloudflare/run_wrangler_kanouk.py"
)
SPEC = importlib.util.spec_from_file_location("run_wrangler_kanouk", MODULE_PATH)
assert SPEC and SPEC.loader
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def credential_text(email: str, account_id: str, token: str) -> str:
    return f"""# Cloudflare

- Email: `{email}`
- Account ID: `{account_id}`
- Token: `{token}`
"""


class CredentialTests(unittest.TestCase):
    def test_loads_configured_credential(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(
                credential_text("kanouk@gmail.com", "account-kanouk", "token-value")
            )
            self.assertEqual(
                guard.load_credential(path),
                {
                    "email": "kanouk@gmail.com",
                    "account_id": "account-kanouk",
                    "api_token": "token-value",
                },
            )

    def test_rejects_placeholder(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(
                credential_text(
                    "kanouk@gmail.com",
                    "REPLACE_WITH_KANOUK_ACCOUNT_ID",
                    "REPLACE_WITH_SCOPED_API_TOKEN",
                )
            )
            with self.assertRaisesRegex(guard.GuardError, "no configured Account ID"):
                guard.load_credential(path)

    def test_rejects_wrong_email(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credential.md"
            path.write_text(
                credential_text(
                    "fragrance.radio@gmail.com", "account-fragrance", "token-value"
                )
            )
            with self.assertRaisesRegex(guard.GuardError, "must be kanouk@gmail.com"):
                guard.load_credential(path)


class AccountGuardTests(unittest.TestCase):
    credential = {
        "email": "kanouk@gmail.com",
        "account_id": "account-kanouk",
        "api_token": "secret-token",
    }

    def test_accepts_only_expected_account(self) -> None:
        guard.validate_whoami(
            {
                "loggedIn": True,
                "email": "kanouk@gmail.com",
                "accounts": [{"id": "account-kanouk"}],
            },
            self.credential,
        )

    def test_rejects_fragrance_account(self) -> None:
        with self.assertRaisesRegex(guard.GuardError, "not kanouk@gmail.com"):
            guard.validate_whoami(
                {
                    "loggedIn": True,
                    "email": "fragrance.radio@gmail.com",
                    "accounts": [{"id": "account-fragrance"}],
                },
                self.credential,
            )

    def test_rejects_token_with_multiple_accounts(self) -> None:
        with self.assertRaisesRegex(guard.GuardError, "not restricted"):
            guard.validate_whoami(
                {
                    "loggedIn": True,
                    "email": "kanouk@gmail.com",
                    "accounts": [
                        {"id": "account-kanouk"},
                        {"id": "account-fragrance"},
                    ],
                },
                self.credential,
            )

    def test_child_environment_overrides_other_cloudflare_credentials(self) -> None:
        env = guard.child_environment(
            self.credential,
            {
                "PATH": "/bin",
                "CLOUDFLARE_API_TOKEN": "wrong-token",
                "CLOUDFLARE_ACCOUNT_ID": "account-fragrance",
                "CLOUDFLARE_API_KEY": "legacy-key",
                "CLOUDFLARE_EMAIL": "fragrance.radio@gmail.com",
            },
        )
        self.assertEqual(env["CLOUDFLARE_API_TOKEN"], "secret-token")
        self.assertEqual(env["CLOUDFLARE_ACCOUNT_ID"], "account-kanouk")
        self.assertNotIn("CLOUDFLARE_API_KEY", env)
        self.assertNotIn("CLOUDFLARE_EMAIL", env)

    def test_blocks_global_auth_commands(self) -> None:
        for command in ("login", "logout"):
            with self.subTest(command=command):
                with self.assertRaisesRegex(guard.GuardError, "global authentication"):
                    guard.normalized_wrangler_args([command])


if __name__ == "__main__":
    unittest.main()
