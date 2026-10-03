#!/usr/bin/env python3
"""Fail closed before an EmDash upgrade that would re-home reference fields.

EmDash 1.0 migration 087 binds every legacy reference field to a relation
unless the field is `indexed` or `searchable`. A bound field stops receiving
writes in its column, while this site reads `photos.album` and
`posts.related_album` from that column and the revision JSON directly
(src/utils/*, src/studio/photo-read.ts, the photo picker's field filter).

This check passes only when:
  * no reference field would be bound by 087, and
  * the fields the site reads are present, column-backed and indexed.

Run it against production before migrating, and against a rehearsal copy
after migrating:

    python3 scripts/cloudflare/check_emdash_reference_fields.py --remote
    python3 scripts/cloudflare/check_emdash_reference_fields.py --sqlite <file>
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from typing import Any, Iterable, Mapping, Sequence

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = REPOSITORY_ROOT / "apps/web"
DATABASE_NAME = "kanouk-content-staging"
REQUIRED_COLUMN_FIELDS = (("photos", "album"), ("posts", "related_album"))
QUERY = (
    "SELECT c.slug AS collection, f.slug AS field, f.indexed AS indexed, "
    "f.searchable AS searchable, f.validation AS validation "
    "FROM _emdash_fields AS f JOIN _emdash_collections AS c ON c.id = f.collection_id "
    "WHERE f.type = 'reference' ORDER BY c.slug, f.slug"
)


def relation_bound(validation: Any) -> bool:
    """True when the field already stores its value as relation edges."""
    if validation in (None, ""):
        return False
    try:
        parsed = json.loads(validation) if isinstance(validation, str) else validation
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and bool(parsed.get("relation"))


def flag(value: Any) -> bool:
    return value in (1, True, "1")


def evaluate(rows: Iterable[Mapping[str, Any]]) -> list[str]:
    """Return human-readable problems; an empty list means safe to migrate."""
    problems: list[str] = []
    seen: dict[tuple[str, str], Mapping[str, Any]] = {}
    for row in rows:
        key = (str(row["collection"]), str(row["field"]))
        seen[key] = row
        if not relation_bound(row.get("validation")) and not (
            flag(row.get("indexed")) or flag(row.get("searchable"))
        ):
            problems.append(
                f"{key[0]}.{key[1]}: not indexed/searchable, so migration 087 would bind it to a relation"
            )
    for key in REQUIRED_COLUMN_FIELDS:
        row = seen.get(key)
        name = f"{key[0]}.{key[1]}"
        if row is None:
            problems.append(f"{name}: reference field is missing")
        elif relation_bound(row.get("validation")):
            problems.append(f"{name}: already bound to a relation; the site reads its column")
        elif not flag(row.get("indexed")):
            problems.append(f"{name}: must stay indexed so it keeps its column")
    return problems


def rows_from_sqlite(path: Path) -> list[dict[str, Any]]:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute(QUERY)]
    finally:
        connection.close()


def rows_from_wrangler_json(output: str) -> list[dict[str, Any]]:
    # The guard banner is buffered, so it can land before or after Wrangler's JSON.
    payload, _ = json.JSONDecoder().raw_decode(output, output.index("["))
    if not isinstance(payload, list) or not payload or not payload[0].get("success", True):
        raise ValueError("Unexpected wrangler d1 execute response")
    return list(payload[0].get("results") or [])


def rows_from_remote() -> list[dict[str, Any]]:
    # The kanouk guard validates the Cloudflare account before running Wrangler.
    completed = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "scripts/cloudflare/run_wrangler_kanouk.py"),
            "d1", "execute", DATABASE_NAME, "--remote", "--json", "--command", QUERY,
        ],
        cwd=WEB_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        raise RuntimeError("wrangler d1 execute failed")
    return rows_from_wrangler_json(completed.stdout)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--remote", action="store_true", help="read the production D1 through the kanouk guard")
    source.add_argument("--sqlite", type=Path, help="read a local D1 sqlite file")
    args = parser.parse_args(argv)
    try:
        rows = rows_from_remote() if args.remote else rows_from_sqlite(args.sqlite)
    except (RuntimeError, ValueError, sqlite3.Error) as error:
        print(f"Reference field check could not run: {error}", file=sys.stderr)
        return 2
    for row in rows:
        state = "relation" if relation_bound(row.get("validation")) else "column"
        print(f"{row['collection']}.{row['field']}: {state}, indexed={row.get('indexed')}, searchable={row.get('searchable')}")
    problems = evaluate(rows)
    if problems:
        print("NOT SAFE to run EmDash migration 087:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("OK: EmDash 1.0 reference migration leaves the fields this site reads untouched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
