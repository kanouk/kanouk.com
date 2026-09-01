import unittest

from scripts.migration.finalize_staging_content import finalize


class FakeClient:
    def __init__(self):
        self.fixtures = {
            "ec_posts": [{"id": "post", "slug": "staging-foundation", "title": "Cloudflare 移行ステージング", "status": "published", "deleted_at": None}],
            "ec_pages": [{"id": "page", "slug": "about", "title": "About", "status": "published", "deleted_at": None}],
            "ec_albums": [{"id": "album", "slug": "staging-album", "title": "Staging Album", "status": "published", "deleted_at": None}],
            "ec_photos": [{"id": "photo", "slug": "staging-avatar", "title": "Staging image", "status": "published", "deleted_at": None}],
        }
        self.widgets = [
            {"id": "search", "component_id": "core:search", "title": "Search"},
            {"id": "categories", "component_id": "core:categories", "title": "Categories"},
            {"id": "tags", "component_id": "core:tags", "title": "Tags"},
        ]
        self.taxonomies = [
            {"id": "category", "name": "category", "label": "Categories", "label_singular": "Category"},
            {"id": "tag", "name": "tag", "label": "Tags", "label_singular": "Tag"},
        ]
        self.seed_terms = [
            {"id": "migration-term", "name": "category", "slug": "migration", "label": "Migration"},
            {"id": "staging-term", "name": "tag", "slug": "staging", "label": "Staging"},
        ]
        self.assignments = {
            "migration-term": [{"collection": "posts", "entry_id": "post"}],
            "staging-term": [{"collection": "posts", "entry_id": "post"}],
        }

    def query(self, sql, params=None):
        params = params or []
        for table, rows in self.fixtures.items():
            if sql.startswith("SELECT") and f"FROM {table}" in sql:
                return [dict(row) for row in rows]
            if sql.startswith(f"UPDATE {table}"):
                for row in rows:
                    if row["id"] == params[2] and row["deleted_at"] is None:
                        row.update(status="draft", deleted_at=params[0])
                return []
        if sql.startswith("SELECT") and "FROM _emdash_widgets" in sql:
            return [dict(row) for row in self.widgets]
        if sql.startswith("UPDATE _emdash_widgets"):
            for row in self.widgets:
                if row["id"] == params[1]:
                    row["title"] = params[0]
            return []
        if sql.startswith("SELECT") and "FROM _emdash_taxonomy_defs" in sql:
            return [dict(row) for row in self.taxonomies]
        if sql.startswith("UPDATE _emdash_taxonomy_defs"):
            for row in self.taxonomies:
                if row["id"] == params[2]:
                    row.update(label=params[0], label_singular=params[1])
            return []
        if sql.startswith("SELECT") and "FROM taxonomies" in sql:
            return [
                dict(row) for row in self.seed_terms
                if row["name"] == params[0] and row["slug"] == params[1] and row["label"] == params[2]
            ]
        if sql.startswith("SELECT") and "FROM content_taxonomies" in sql:
            return [dict(row) for row in self.assignments.get(params[0], [])]
        if sql.startswith("DELETE FROM content_taxonomies"):
            self.assignments.pop(params[0], None)
            return []
        if sql.startswith("DELETE FROM taxonomies"):
            self.seed_terms = [row for row in self.seed_terms if row["id"] != params[0]]
            return []
        raise AssertionError(sql)


class FinalizeStagingContentTests(unittest.TestCase):
    def test_dry_run_reports_without_mutation(self):
        client = FakeClient()
        result = finalize(client, apply=False, now="2026-09-01T00:00:00Z")
        self.assertEqual(result["fixtures"]["posts"]["active"], 1)
        self.assertEqual(result["widget_updates"], 3)
        self.assertEqual(result["taxonomy_updates"], 2)
        self.assertEqual(result["synthetic_terms"], 2)
        self.assertIsNone(client.fixtures["ec_posts"][0]["deleted_at"])

    def test_apply_soft_deletes_and_localizes_idempotently(self):
        client = FakeClient()
        finalize(client, apply=True, now="2026-09-01T00:00:00Z")
        self.assertTrue(all(rows[0]["deleted_at"] for rows in client.fixtures.values()))
        self.assertEqual([row["title"] for row in client.widgets], ["検索", "カテゴリー", "タグ"])
        self.assertEqual([row["label"] for row in client.taxonomies], ["カテゴリー", "タグ"])
        self.assertEqual(client.seed_terms, [])
        second = finalize(client, apply=True, now="2026-09-01T00:01:00Z")
        self.assertTrue(all(item["active"] == 0 for item in second["fixtures"].values()))
        self.assertEqual(second["widget_updates"], 0)
        self.assertEqual(second["taxonomy_updates"], 0)
        self.assertEqual(second["synthetic_terms"], 0)


if __name__ == "__main__":
    unittest.main()
