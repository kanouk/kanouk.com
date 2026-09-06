import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('public link cards use internal CMS metadata and read-only external cache', async () => {
  const source = await readFile(new URL('../plugins/yohaku-content-blocks/src/astro/LinkCard.astro', import.meta.url), 'utf8');
  assert.match(source, /resolveInternalLinkPreview\(env\.DB/);
  assert.match(source, /getCachedLinkPreview\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bgetLinkPreview\s*\(/);
  assert.match(source, /savedText\(description\) \|\| metadata\?\.description/);
  assert.match(source, /savedText\(imageUrl\) \|\| metadata\?\.imageUrl/);
  assert.match(source, /referrerpolicy="no-referrer"/);
});
