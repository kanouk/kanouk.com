from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts/migration/migrate_smugmug_catalog.py"
SPEC = importlib.util.spec_from_file_location("migrate_smugmug_catalog", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class SmugMugCatalogMigrationTests(unittest.TestCase):
    def test_filters_catalog_by_source_album_key(self) -> None:
        catalog = {
            "albums": [
                {"source_album_key": "one"},
                {"source_album_key": "two"},
                {"source_album_key": "three"},
            ]
        }
        rows = module.selected_rows(catalog, include={"one", "two"}, exclude={"two"})
        self.assertEqual([row["source_album_key"] for row in rows], ["one"])


if __name__ == "__main__":
    unittest.main()
