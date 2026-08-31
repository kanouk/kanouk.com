import tempfile
import unittest
from pathlib import Path

from scripts.migration.migrate_wordpress_comments import comment_id, migrate, parse_comments, plain_comment, status


class WordPressCommentMigrationTests(unittest.TestCase):
    def test_plain_comment_preserves_paragraphs_and_escapes_no_html(self):
        self.assertEqual(plain_comment("<p>Hello<br>world</p><p>Next</p>"), "Hello\nworld\nNext")

    def test_status_mapping_is_fail_closed(self):
        self.assertEqual(status("1"), "approved")
        self.assertEqual(status("0"), "pending")
        self.assertEqual(status("spam"), "spam")
        self.assertEqual(status("unexpected"), "pending")

    def test_parses_comment_without_persisting_source_ip(self):
        xml = """<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><item><wp:post_id>42</wp:post_id><wp:post_type>post</wp:post_type><wp:comment><wp:comment_id>9</wp:comment_id><wp:comment_author>A</wp:comment_author><wp:comment_author_email>a@example.com</wp:comment_author_email><wp:comment_author_IP>192.0.2.1</wp:comment_author_IP><wp:comment_date_gmt>2020-01-02 03:04:05</wp:comment_date_gmt><wp:comment_content>&lt;p&gt;Body&lt;/p&gt;</wp:comment_content><wp:comment_approved>1</wp:comment_approved><wp:comment_parent>0</wp:comment_parent></wp:comment></item></channel></rss>"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "export.xml"
            path.write_text(xml)
            value = parse_comments("site", path)[0]
        self.assertEqual(value["id"], comment_id("site", "9"))
        self.assertEqual(value["source_post_id"], "42")
        self.assertEqual(value["body"], "Body")
        self.assertNotIn("ip", value)

    def test_page_comments_keep_their_collection(self):
        class FakeClient:
            def __init__(self):
                self.insert_params = []

            def query(self, sql, params=None):
                if "UNION ALL" in sql:
                    return [{"id": "page-1", "source_id": "kanolog:9", "collection": "pages"}]
                if sql.startswith("INSERT"):
                    self.insert_params = params
                    return []
                if "FROM _emdash_comments" in sql:
                    return [{
                        "id": "wpc-test", "collection": "pages", "content_id": "page-1", "parent_id": None,
                        "author_name": "A", "author_email": "", "body": "B", "status": "approved",
                        "moderation_metadata": "{}", "created_at": "2026-01-01T00:00:00Z",
                    }]
                return []

        comment = {
            "id": "wpc-test", "site": "kanolog", "source_id": "1", "source_post_id": "9",
            "parent_id": None, "author_name": "A", "author_email": "", "body": "B",
            "status": "approved", "moderation_metadata": "{}", "created_at": "2026-01-01T00:00:00Z",
        }
        client = FakeClient()
        self.assertEqual(migrate(client, [comment], True), {"approved": 1})
        self.assertEqual(client.insert_params[1:3], ["pages", "page-1"])


if __name__ == "__main__":
    unittest.main()
