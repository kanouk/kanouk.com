#!/usr/bin/env python3
"""Populate OGP cache from published article URLs without editing CMS revisions.

Default is a read-only plan. --apply backs up affected cache options, conditionally
updates snapshots, and reads each back. All D1 calls use the existing account guard.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile

from run_wrangler_kanouk import WEB_ROOT, WRANGLER_BIN, child_environment, load_credential, preflight


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entry-id', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not all(len(value) == 26 and value.isalnum() for value in args.entry_id):
        raise SystemExit('Explicit EmDash article IDs are required')
    credential = load_credential()
    env = child_environment(credential)
    preflight(credential, env)

    def query(sql: str) -> list[dict]:
        # --file uses Wrangler's bulk-import path; --command returns SELECT rows.
        # Pass SQL as one subprocess argument, never through a shell.
        result = subprocess.run([str(WRANGLER_BIN), 'd1', 'execute', 'kanouk-content-staging', '--remote', '--command', sql, '--json'], cwd=WEB_ROOT, env=env, text=True, capture_output=True, check=True)
        payload = json.loads(result.stdout)
        if not all(item.get('success') for item in payload):
            raise RuntimeError('D1 query failed')
        return [row for item in payload for row in item.get('results', [])]

    ids = ','.join(quote(value) for value in args.entry_id)
    rows = query(f"""SELECT p.id, b.value AS block FROM ec_posts p
        JOIN revisions live ON live.id=p.live_revision_id, json_each(live.data,'$.content') b
        WHERE p.id IN ({ids}) AND p.status='published' AND p.deleted_at IS NULL
        AND json_extract(b.value,'$._type')='yohaku.linkCard'""")
    urls = []
    for row in rows:
        block = json.loads(row['block'])
        value = block.get('id') or block.get('url')
        if isinstance(value, str) and value.startswith('https://'):
            urls.append(value)
    fetched = subprocess.run(['node', '--experimental-strip-types', 'scripts/fetch-public-link-previews.mjs'], cwd=WEB_ROOT, input=json.dumps(urls), text=True, capture_output=True, check=True)
    plan = json.loads(fetched.stdout)
    ready = [item for item in plan if 'value' in item]
    print(json.dumps({'mode':'apply' if args.apply else 'plan', 'entries':args.entry_id, 'results':[{'url':item['url'], 'error':item.get('error'), 'title':item.get('value',{}).get('metadata',{}).get('title'), 'hasImage':bool(item.get('value',{}).get('metadata',{}).get('imageUrl'))} for item in plan]}, ensure_ascii=False))
    if not args.apply or not ready:
        return
    names = ','.join(quote(item['name']) for item in ready)
    before = query(f'SELECT name,value FROM options WHERE name IN ({names})')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path(tempfile.gettempdir()) / f'kanouk-link-preview-cache-{stamp}.json'
    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump({'entries':args.entry_id, 'before':before, 'proposed':ready}, stream, ensure_ascii=False, indent=2)
    statements = []
    for item in ready:
        value = json.dumps(item['value'], ensure_ascii=False)
        statements.append(f"INSERT INTO options(name,value) VALUES({quote(item['name'])},{quote(value)}) ON CONFLICT(name) DO UPDATE SET value=excluded.value WHERE COALESCE(json_extract(options.value,'$.fetchedAt'),'') <= json_extract(excluded.value,'$.fetchedAt');")
    query('\n'.join(statements))
    after = {row['name']:json.loads(row['value']) for row in query(f'SELECT name,value FROM options WHERE name IN ({names})')}
    for item in ready:
        current = after[item['name']]
        if current.get('fetchedAt', '') < item['value']['fetchedAt']:
            raise RuntimeError('Cache readback did not retain the fetched snapshot')
        if current.get('fetchedAt') == item['value']['fetchedAt'] and current.get('metadata') != item['value']['metadata']:
            raise RuntimeError('Cache metadata readback mismatch')
    print(json.dumps({'verified':len(ready), 'backup':str(backup), 'cmsRevisionsWritten':0}))


if __name__ == '__main__':
    main()
