from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/smugmug_oauth.py"
SPEC = importlib.util.spec_from_file_location("smugmug_oauth", MODULE_PATH)
assert SPEC and SPEC.loader
oauth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oauth)


class SmugMugOAuthTests(unittest.TestCase):
    def test_rfc5849_hmac_sha1_example(self) -> None:
        signature = oauth.hmac_sha1_signature(
            "POST",
            "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
            [
                ("b5", "=%3D"),
                ("a3", "a"),
                ("c@", ""),
                ("a2", "r b"),
                ("oauth_consumer_key", "9djdj82h48djs9d2"),
                ("oauth_token", "kkk9d7dh3k39sjv7"),
                ("oauth_signature_method", "HMAC-SHA1"),
                ("oauth_timestamp", "137131201"),
                ("oauth_nonce", "7d8f3e4a"),
                ("c2", ""),
                ("a3", "2 q"),
            ],
            consumer_secret="j49sk3j29djd",
            token_secret="dh893hdasih9",
        )
        self.assertEqual(signature, "r6/TJjbCOr97/+UU0NsvSne7s5g=")

    def test_authorization_header_is_deterministic_with_fixed_clock(self) -> None:
        header = oauth.authorization_header(
            "GET",
            "https://api.smugmug.com/api/v2!authuser?count=50",
            consumer_key="key",
            consumer_secret="secret",
            token="token",
            token_secret="token-secret",
            nonce="nonce",
            timestamp="1234567890",
        )
        self.assertTrue(header.startswith("OAuth "))
        self.assertIn('oauth_consumer_key="key"', header)
        self.assertIn('oauth_token="token"', header)
        self.assertIn("oauth_signature=", header)


if __name__ == "__main__":
    unittest.main()
