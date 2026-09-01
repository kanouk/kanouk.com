from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/backup_cloudflare_staging.py"
SPEC = importlib.util.spec_from_file_location("backup_cloudflare_staging", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class CloudflareBackupTests(unittest.TestCase):
    def test_json_writer_is_atomic_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            module.write_json_atomic(path, {"ok": True})
            self.assertEqual(path.read_text(), '{\n  "ok": true\n}\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_sql_literal_preserves_text_null_numbers_and_blobs(self) -> None:
        self.assertEqual(module.sql_literal(None), "NULL")
        self.assertEqual(module.sql_literal(42), "42")
        self.assertEqual(module.sql_literal("Kano's log"), "'Kano''s log'")
        self.assertEqual(module.sql_literal([0, 127, 255]), "X'007fff'")
        self.assertEqual(
            module.sql_literal({"type": "Buffer", "data": [1, 2, 3]}),
            "X'010203'",
        )

    def test_fts_shadow_tables_are_excluded_from_logical_dump(self) -> None:
        self.assertTrue(module.FTS_VIRTUAL_TABLE.fullmatch("_emdash_fts_posts"))
        self.assertTrue(module.FTS_SHADOW_TABLE.fullmatch("_emdash_fts_posts_data"))
        self.assertFalse(module.FTS_SHADOW_TABLE.fullmatch("ec_posts"))
        self.assertIn("_cf_KV", module.PROTECTED_D1_TABLES)

    def test_fts_restore_looks_up_the_source_rowid_by_content_id(self) -> None:
        statement = module.insert_fts_statements(
            "_emdash_fts_posts",
            "ec_posts",
            ["id", "title"],
            [{"id": "post-1", "title": "Hello"}],
        )[0]
        self.assertIn('SELECT rowid FROM "ec_posts" WHERE "id" = \'post-1\'', statement)
        self.assertIn('INSERT INTO "_emdash_fts_posts" ("rowid", "id", "title")', statement)

    def test_file_hash_returns_sha1_sha256_and_size(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.bin"
            path.write_bytes(b"kanouk")
            sha1, sha256, size = module.hash_file(path)
            self.assertEqual(sha1, "5ac6c380000fc0f0f4f85d8c3043ca229ffa1a49")
            self.assertEqual(
                sha256,
                "995ce18769a9ff6098a39942169e3af9daf55af50aed827f66415bb0e2acc594",
            )
            self.assertEqual(size, 6)


if __name__ == "__main__":
    unittest.main()
