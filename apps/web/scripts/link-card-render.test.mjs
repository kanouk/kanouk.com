import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('public link cards render without external SSR fetch and opt into scoped client refresh', async () => {
  const source = await readFile(new URL('../plugins/yohaku-content-blocks/src/astro/LinkCard.astro', import.meta.url), 'utf8');
  assert.match(source, /resolveInternalLinkPreview\(env\.DB/);
  assert.match(source, /getCachedLinkPreviewIncludingStale\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bgetLinkPreview\s*\(/);
  assert.match(source, /manualDescription \|\| currentAuto\?\.description/);
  assert.match(source, /manualImage \|\| safeLinkPreviewImageUrl\(currentAuto\?\.imageUrl/);
  assert.match(source, /data-block-key=/);
  assert.match(source, /import "\.\.\/link-preview-client"/);
  assert.match(source, /referrerpolicy="no-referrer"/);
});
