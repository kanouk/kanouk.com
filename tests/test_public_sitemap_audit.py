from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/audit_public_sitemaps.py"
SPEC = importlib.util.spec_from_file_location("audit_public_sitemaps", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class PublicSitemapAuditTests(unittest.TestCase):
    def test_parser_collects_links_and_nonempty_title(self) -> None:
        parser = module.PageParser()
        parser.feed('<title>カノログ</title><a href="/posts/example#top">読む</a>')
        self.assertTrue(parser.has_title)
        self.assertEqual(parser.hrefs, ["/posts/example#top"])

    def test_normalizes_internal_link_without_fragment(self) -> None:
        self.assertEqual(
            module.normalize_link("../posts/example#top", "https://example.com/pages/about"),
            "https://example.com/posts/example",
        )
        self.assertTrue(
            module.on_base_origin("https://example.com/posts/example", "https://example.com")
        )
        self.assertFalse(
            module.on_base_origin("https://other.example/posts/example", "https://example.com")
        )

    def test_forbidden_patterns_cover_migration_residue(self) -> None:
        samples = {
            "wordpress_pseudo_url": b'href="wordpress://nocalog/post/42"',
            "wordpress_upload": b"https://kanolog.net/wp-content/uploads/a.jpg",
            "smugmug": b"https://kanolog.smugmug.com/gallery",
            "legacy_site_link": b'<a href="https://art-quiz.com/sample">',
            "gutenberg_comment": b"<!-- wp:paragraph -->",
            "legacy_shortcode": b"[pochipp id=12]",
            "plugin_placeholder": b"Plugin block: yohaku.linkCard (edit in admin)",
        }
        for name, sample in samples.items():
            with self.subTest(name=name):
                self.assertTrue(module.FORBIDDEN[name].search(sample))

    def test_public_crawl_retries_transient_not_found_and_worker_errors(self) -> None:
        self.assertIn(404, module.RETRY_STATUSES)
        self.assertIn(500, module.RETRY_STATUSES)
        self.assertIn(524, module.RETRY_STATUSES)
        self.assertEqual(module.MAX_FETCH_ATTEMPTS, 5)

    def test_smugmug_allowlist_only_suppresses_the_matching_reference(self) -> None:
        body = (
            b'<img src="https://photos.smugmug.com/a/i-allowed/image.jpg">'
            b'<img src="https://photos.smugmug.com/a/i-unresolved/image.jpg">'
        )
        self.assertEqual(
            module.count_forbidden(
                "smugmug", body, allowed_smugmug_ids=["allowed"]
            ),
            1,
        )

    def test_smugmug_allowlist_can_suppress_one_known_reference(self) -> None:
        body = b'<img src="https://photos.smugmug.com/a/i-allowed/image.jpg">'
        self.assertEqual(
            module.count_forbidden(
                "smugmug", body, allowed_smugmug_ids=["allowed"]
            ),
            0,
        )


if __name__ == "__main__":
    unittest.main()
