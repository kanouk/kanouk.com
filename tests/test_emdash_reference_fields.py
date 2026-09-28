from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/cloudflare/check_emdash_reference_fields.py"
SPEC = importlib.util.spec_from_file_location("check_emdash_reference_fields", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def row(collection: str, field: str, indexed: int = 1, searchable: int = 0, validation: str | None = None) -> dict:
    return {"collection": collection, "field": field, "indexed": indexed, "searchable": searchable, "validation": validation}


SAFE = [row("photos", "album"), row("posts", "related_album")]


class ReferenceFieldCheckTests(unittest.TestCase):
    def test_indexed_column_fields_are_safe(self) -> None:
        self.assertEqual(module.evaluate(SAFE), [])

    def test_unindexed_reference_would_be_rebound(self) -> None:
        problems = module.evaluate([row("photos", "album", indexed=0), row("posts", "related_album")])
        self.assertTrue(any("photos.album" in problem and "087" in problem for problem in problems))
        self.assertTrue(any("photos.album" in problem and "indexed" in problem for problem in problems))

    def test_any_other_unindexed_reference_blocks_the_upgrade(self) -> None:
        problems = module.evaluate([*SAFE, row("pages", "parent", indexed=0)])
        self.assertEqual(len(problems), 1)
        self.assertIn("pages.parent", problems[0])

    def test_searchable_or_already_bound_fields_are_not_rebound(self) -> None:
        rows = [*SAFE, row("pages", "a", indexed=0, searchable=1), row("pages", "b", indexed=0, validation=json.dumps({"relation": "x"}))]
        self.assertEqual(module.evaluate(rows), [])

    def test_fields_the_site_reads_must_exist_and_keep_their_column(self) -> None:
        self.assertIn("posts.related_album: reference field is missing", module.evaluate([row("photos", "album")]))
        bound = module.evaluate([row("photos", "album", validation='{"relation":"photos-album"}'), row("posts", "related_album")])
        self.assertTrue(any("already bound" in problem for problem in bound))

    def test_reads_a_local_d1_sqlite_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "d1.sqlite"
            connection = sqlite3.connect(path)
            connection.executescript(
                "CREATE TABLE _emdash_collections (id TEXT, slug TEXT);"
                "CREATE TABLE _emdash_fields (collection_id TEXT, slug TEXT, type TEXT, indexed INTEGER, searchable INTEGER, validation TEXT);"
                "INSERT INTO _emdash_collections VALUES ('c1','photos'),('c2','posts');"
                "INSERT INTO _emdash_fields VALUES ('c1','album','reference',1,0,NULL),('c2','related_album','reference',1,0,NULL),('c2','title','string',0,1,NULL);"
            )
            connection.commit()
            connection.close()
            rows = module.rows_from_sqlite(path)
            self.assertEqual([(r["collection"], r["field"]) for r in rows], [("photos", "album"), ("posts", "related_album")])
            self.assertEqual(module.main(["--sqlite", str(path)]), 0)

    def test_parses_wrangler_json_output_after_guard_banner(self) -> None:
        output = "Cloudflare guard passed: kanouk@gmail.com / account …abcdef\n" + json.dumps([{"results": SAFE, "success": True}])
        self.assertEqual(module.rows_from_wrangler_json(output), SAFE)
        with self.assertRaises(ValueError):
            module.rows_from_wrangler_json(json.dumps([{"results": [], "success": False}]))


if __name__ == "__main__":
    unittest.main()
