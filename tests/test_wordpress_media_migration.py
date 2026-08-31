import tempfile
import unittest
from pathlib import Path

from scripts.migration.migrate_wordpress_media import (
    attachment_aliases,
    parse_wxr_attachments,
    should_retry,
)


class WordPressMediaMigrationTests(unittest.TestCase):
    def test_extracts_attachment_metadata_and_size_aliases(self):
        xml = """<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"><channel><item><title>Hero</title><guid>https://example.com/?attachment_id=42</guid><wp:post_type>attachment</wp:post_type><wp:post_id>42</wp:post_id><wp:attachment_url>https://example.com/wp-content/uploads/2024/01/hero-scaled.jpg</wp:attachment_url><wp:post_mime_type>image/jpeg</wp:post_mime_type><wp:post_parent>7</wp:post_parent><excerpt:encoded>Caption</excerpt:encoded><content:encoded>Description</content:encoded><wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value>Alternative</wp:meta_value></wp:postmeta><wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value>a:1:{s:4:"file";s:16:"hero-300x200.jpg";}</wp:meta_value></wp:postmeta></item></channel></rss>"""
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "export.xml"
            source.write_text(xml)
            item = parse_wxr_attachments("test", source)[0]
        self.assertEqual(item["key"], "test:42")
        self.assertEqual(item["alt"], "Alternative")
        self.assertEqual(item["caption"], "Caption")
        self.assertIn("https://example.com/wp-content/uploads/2024/01/hero-300x200.jpg", item["aliases"])

    def test_aliases_include_original_and_queryless_url(self):
        aliases = attachment_aliases(
            "https://example.com/wp-content/uploads/a.png?ver=1",
            "",
            {},
        )
        self.assertIn("https://example.com/wp-content/uploads/a.png?ver=1", aliases)
        self.assertIn("https://example.com/wp-content/uploads/a.png", aliases)

    def test_retry_is_limited_to_transient_failures(self):
        self.assertTrue(should_retry(503))
        self.assertTrue(should_retry(429))
        self.assertFalse(should_retry(500))
        self.assertFalse(should_retry(404))


if __name__ == "__main__":
    unittest.main()
