from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts/cloudflare"
sys.path.insert(0, str(SCRIPTS))
import run_emdash_release_posts_kanouk as release


class ReleasePostGuardTest(unittest.TestCase):
    def test_post_authoring_is_allowed(self):
        for action in ["list", "get", "create", "update", "publish", "unpublish"]:
            args = ["content", action, "posts", "--json"]
            self.assertEqual(release.normalized_args(args), args)

    def test_other_collections_and_destructive_operations_are_rejected(self):
        for args in [["content", "create", "photos"], ["content", "delete", "posts", "id"], ["media", "delete", "id"], ["schema", "create", "posts"]]:
            with self.assertRaises(release.emdash.EmDashGuardError):
                release.normalized_args(args)

    def test_origin_and_authentication_cannot_be_overridden(self):
        for extra in [["--url=https://example.com"], ["--url", "https://example.com"], ["--token=other"], ["--token", "other"], ["-uhttps://example.com"], ["-HAuthorization: other"]]:
            with self.assertRaises(release.emdash.EmDashGuardError):
                release.normalized_args(["content", "list", "posts", *extra])

    def test_scopes_are_limited_and_credential_is_separate(self):
        self.assertEqual(set(release.SCOPES), {"content:read", "content:write", "media:read", "media:write", "schema:read"})
        self.assertNotEqual(release.TOKEN_FILE, release.emdash.DEFAULT_CREDENTIAL_FILE)


if __name__ == "__main__":
    unittest.main()
