import unittest

from scripts.migration.fetch_wordpress_rest_delta import compact_post


class WordPressRestDeltaTests(unittest.TestCase):
    def test_compacts_edit_context_without_rendered_wrapper(self):
        post = compact_post(
            {
                "id": 42,
                "title": {"raw": "Title", "rendered": "Rendered"},
                "content": {"raw": "<!-- wp:paragraph --><p>Body</p><!-- /wp:paragraph -->"},
                "excerpt": {"raw": "Excerpt"},
                "categories": [3],
                "tags": [4],
                "meta": {"key": "value"},
            }
        )
        self.assertEqual(post["title"], "Title")
        self.assertIn("wp:paragraph", post["content"])
        self.assertEqual(post["categories"], [3])
        self.assertEqual(post["meta"], {"key": "value"})


if __name__ == "__main__":
    unittest.main()
