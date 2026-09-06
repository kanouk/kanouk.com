// Local-only integration smoke test. Never accepts a remote URL or production credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

if (!process.argv.includes('--confirm-local')) throw new Error('Requires --confirm-local; creates a local draft and media fixture.');
const origin = 'http://127.0.0.1:4321';
const login = await fetch(`${origin}/_emdash/api/setup/dev-bypass?content=0&redirect=/_emdash/admin`, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Local dev bypass must issue a session');
async function api(path, options = {}) {
  return fetch(origin + path, { ...options, headers: { Cookie: cookie, Origin: origin, 'X-EmDash-Request': '1', ...options.headers } });
}
async function payload(response) {
  const body = await response.json();
  assert.equal(response.ok && body.success, true, `API failed: ${response.status} ${JSON.stringify(body.error)}`);
  return body.data;
}
const form = new FormData();
form.set('file', new File([await readFile(new URL('../public/kanolog-no-image.png', import.meta.url))], 'ux-local-upload.png', { type: 'image/png' }));
const { item: media } = await payload(await api('/_emdash/api/media', { method: 'POST', body: form }));
assert.ok(media.id && media.storageKey, 'Media upload returns reusable identity');
const { item: photo } = await payload(await api('/_emdash/api/content/photos', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'draft', locale: 'ja', data: {
    title: 'Local upload verification', alt: 'Local upload verification', caption: '',
    album: 'ux-album', position: 20480, kind: 'image', source_system: 'ux-fixture', source_id: media.id,
    image: { id: media.id, src: media.url, meta: { storageKey: media.storageKey } },
    source_metadata: { photo_organizer_upload: true, location_review: 'unreviewed' },
  } }),
}));
assert.equal(photo.status, 'draft');
const rawPath = `/_emdash/api/media/file/${encodeURIComponent(media.storageKey)}`;
const anonymous = await fetch(origin + rawPath);
const authenticated = await api(rawPath);
console.log(JSON.stringify({ mediaCreated: true, photoCreated: true, draft: true, anonymousRawStatus: anonymous.status, authenticatedRawStatus: authenticated.status, authenticatedCache: authenticated.headers.get('cache-control') }));
assert.equal(anonymous.status, 404, 'Anonymous draft raw media must be denied');
assert.equal(authenticated.status, 200, 'Admin can inspect draft raw media');
assert.match(authenticated.headers.get('cache-control') ?? '', /private.*no-store/);
const previewPath = `/_yohaku/media/preview-v2/480/webp/${encodeURIComponent(media.storageKey)}`;
assert.equal((await fetch(origin + previewPath)).status, 404, 'Anonymous draft preview must be denied');
const preview = await api(previewPath);
assert.equal(preview.status, 200);
assert.match(preview.headers.get('cache-control') ?? '', /private.*no-store/);
assert.match(preview.headers.get('content-type') ?? '', /image\/png/, 'Private preview serves the original without entering the public optimizer');
const publish = await api(`/_emdash/api/content/photos/${photo.id}/publish?locale=ja`, { method: 'POST' });
assert.equal(publish.status, 409, 'Unreviewed upload must not publish');
console.log('Local upload/privacy API smoke passed; fixture remains local and draft.');
