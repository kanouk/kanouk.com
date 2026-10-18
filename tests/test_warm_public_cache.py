import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).parents[1] / "scripts/cloudflare/warm_public_cache.py"
SPEC = importlib.util.spec_from_file_location("warm_public_cache", MODULE_PATH)
warm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(warm)


class WarmPublicCacheTest(unittest.TestCase):
    def test_links_are_unique_same_site_and_limited(self) -> None:
        html = (
            '<a href="/posts/a">a</a><a href="/posts/a">again</a>'
            '<a href="/posts/b?x=1">b</a><a href="https://evil.example/posts/c">c</a>'
            '<a href="/posts/d#top">d</a><a href="/posts/e">e</a>'
        )
        self.assertEqual(warm.links(html, "/posts/", 3), ["/posts/a", "/posts/b", "/posts/d"])

    def test_only_public_hosts(self) -> None:
        self.assertEqual(warm.BLOG, "https://blog.kanouk.com")
        self.assertEqual(warm.PHOTOS, "https://photos.kanouk.com")


if __name__ == "__main__":
    unittest.main()
