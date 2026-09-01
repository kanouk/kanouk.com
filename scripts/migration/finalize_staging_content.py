#!/usr/bin/env python3
"""Retire synthetic fixtures and localize staging chrome in the pinned D1.

Dry-run is the default. The operation is deliberately recoverable: synthetic
entries are soft-deleted, while their revisions and media remain in the verified
backup. Every target is identified by source metadata or a narrow seed-only
signature before any write is allowed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any, Protocol


REPO_ROOT = Path(__file__).resolve().parents[2]
CLOUDFLARE_SCRIPTS = REPO_ROOT / "scripts/cloudflare"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(CLOUDFLARE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(CLOUDFLARE_SCRIPTS))

from run_wrangler_kanouk import child_environment, load_credential, preflight  # noqa: E402
from scripts.migration.migrate_wordpress_comments import D1Client  # noqa: E402


class QueryClient(Protocol):
    def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]: ...


FIXTURE_QUERIES = {
    "posts": (
        "ec_posts",
        "SELECT id,slug,title,status,deleted_at FROM ec_posts "
        "WHERE source_id='synthetic:staging-foundation' "
        "AND json_extract(source_metadata,'$.deleteBeforeProduction')=1",
    ),
    "pages": (
        "ec_pages",
        "SELECT id,slug,title,status,deleted_at FROM ec_pages "
        "WHERE slug='about' AND title='About' AND source_id IS NULL AND source_url IS NULL",
    ),
    "albums": (
        "ec_albums",
        "SELECT id,slug,title,status,deleted_at FROM ec_albums "
        "WHERE source_album_key='synthetic:staging-album' "
        "AND json_extract(source_metadata,'$.deleteBeforeProduction')=1",
    ),
    "photos": (
        "ec_photos",
        "SELECT id,slug,title,status,deleted_at FROM ec_photos "
        "WHERE source_system='synthetic' AND source_id='github:kanouk.com/avatar.png' "
        "AND json_extract(source_metadata,'$.deleteBeforeProduction')=1",
    ),
}

WIDGET_TITLES = {
    "core:search": "検索",
    "core:categories": "カテゴリー",
    "core:tags": "タグ",
}

TAXONOMY_LABELS = {
    "category": ("カテゴリー", "カテゴリー"),
    "tag": ("タグ", "タグ"),
}

SYNTHETIC_TERMS = {
    "migration": ("category", "Migration"),
    "staging": ("tag", "Staging"),
}


def finalize(client: QueryClient, *, apply: bool, now: str | None = None) -> dict[str, Any]:
    timestamp = now or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    fixtures: dict[str, list[dict[str, Any]]] = {}

    for name, (table, query) in FIXTURE_QUERIES.items():
        rows = client.query(query)
        if len(rows) > 1:
            raise RuntimeError(f"Refusing to modify {name}: expected at most one seed fixture, found {len(rows)}")
        fixtures[name] = rows
        if apply and rows and not rows[0].get("deleted_at"):
            client.query(
                f"UPDATE {table} SET status='draft',deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
                [timestamp, timestamp, rows[0]["id"]],
            )

    seed_terms: list[dict[str, Any]] = []
    for slug, (name, label) in SYNTHETIC_TERMS.items():
        rows = client.query(
            "SELECT id,name,slug,label FROM taxonomies WHERE name=? AND slug=? AND label=?",
            [name, slug, label],
        )
        if len(rows) > 1:
            raise RuntimeError(f"Refusing to remove duplicate synthetic taxonomy term: {name}/{slug}")
        seed_terms.extend(rows)
    if seed_terms:
        post_ids = {row["id"] for row in fixtures["posts"]}
        for term in seed_terms:
            assignments = client.query(
                "SELECT collection,entry_id FROM content_taxonomies WHERE taxonomy_id=?",
                [term["id"]],
            )
            if any(row.get("collection") != "posts" or row.get("entry_id") not in post_ids for row in assignments):
                raise RuntimeError("Refusing to remove a synthetic term assigned to non-fixture content")
            if apply:
                client.query("DELETE FROM content_taxonomies WHERE taxonomy_id=?", [term["id"]])
                client.query("DELETE FROM taxonomies WHERE id=?", [term["id"]])

    widgets = client.query(
        "SELECT w.id,w.component_id,w.title FROM _emdash_widgets w "
        "JOIN _emdash_widget_areas a ON a.id=w.area_id WHERE a.name='sidebar'"
    )
    unknown_widgets = [row for row in widgets if row.get("component_id") not in WIDGET_TITLES]
    if unknown_widgets:
        raise RuntimeError("Refusing to localize sidebar with unknown widget components")
    if apply:
        for row in widgets:
            expected = WIDGET_TITLES[row["component_id"]]
            if row.get("title") != expected:
                client.query("UPDATE _emdash_widgets SET title=? WHERE id=?", [expected, row["id"]])

    taxonomies = client.query(
        "SELECT id,name,label,label_singular FROM _emdash_taxonomy_defs WHERE name IN ('category','tag')"
    )
    if {row.get("name") for row in taxonomies} != set(TAXONOMY_LABELS):
        raise RuntimeError("Refusing to localize an incomplete taxonomy definition set")
    if apply:
        for row in taxonomies:
            label, singular = TAXONOMY_LABELS[row["name"]]
            if row.get("label") != label or row.get("label_singular") != singular:
                client.query(
                    "UPDATE _emdash_taxonomy_defs SET label=?,label_singular=? WHERE id=?",
                    [label, singular, row["id"]],
                )

    if apply:
        remaining = {}
        for name, (_table, query) in FIXTURE_QUERIES.items():
            rows = client.query(query)
            remaining[name] = sum(1 for row in rows if not row.get("deleted_at"))
        if any(remaining.values()):
            raise RuntimeError(f"Synthetic fixture readback failed: {remaining}")
        readback_widgets = client.query(
            "SELECT w.component_id,w.title FROM _emdash_widgets w "
            "JOIN _emdash_widget_areas a ON a.id=w.area_id WHERE a.name='sidebar'"
        )
        if any(row.get("title") != WIDGET_TITLES.get(row.get("component_id")) for row in readback_widgets):
            raise RuntimeError("Localized widget readback failed")
        for slug, (name, label) in SYNTHETIC_TERMS.items():
            if client.query(
                "SELECT id FROM taxonomies WHERE name=? AND slug=? AND label=?",
                [name, slug, label],
            ):
                raise RuntimeError(f"Synthetic taxonomy readback failed: {name}/{slug}")

    return {
        "apply": apply,
        "fixtures": {
            name: {
                "found": len(rows),
                "active": sum(1 for row in rows if not row.get("deleted_at")),
            }
            for name, rows in fixtures.items()
        },
        "widget_updates": sum(
            row.get("title") != WIDGET_TITLES.get(row.get("component_id")) for row in widgets
        ),
        "taxonomy_updates": sum(
            (row.get("label"), row.get("label_singular")) != TAXONOMY_LABELS[row["name"]]
            for row in taxonomies
        ),
        "synthetic_terms": len(seed_terms),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    credential = load_credential()
    preflight(credential, child_environment(credential))
    result = finalize(
        D1Client(credential["account_id"], credential["api_token"]),
        apply=args.apply,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
