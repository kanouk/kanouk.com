// Local-only integration check: never accepts production credentials or an origin override.
import assert from 'node:assert/strict';

if (!process.argv.includes('--confirm-local')) throw new Error('Requires --confirm-local; writes only local metadata cache.');
const origin = 'http://127.0.0.1:4321';
const path = '/_emdash/api/plugins/yohaku-content-blocks/link-preview';
const input = { url: 'https://blog.kanouk.com/posts/ux-article' };
const anonymous = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
assert.ok([401, 403].includes(anonymous.status), 'Anonymous metadata lookup must be rejected');
const login = await fetch(`${origin}/_emdash/api/setup/dev-bypass?content=0&redirect=/_emdash/admin`, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Local dev session required');
async function lookup(url, extra = {}) {
  return fetch(origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-EmDash-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), ...extra });
}
const internalResponse = await lookup(input.url);
const internal = await internalResponse.json();
assert.equal(internalResponse.ok, true, JSON.stringify(internal));
assert.ok(internal.data.title && internal.data.description && internal.data.imageUrl, 'Internal published article supplies all metadata');
const csrf = await fetch(origin + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
assert.equal(csrf.status, 403, 'Ambient session without CSRF header must fail');
for (const url of ['http://127.0.0.1/private', 'https://127.0.0.1/', 'https://user:secret@example.com/', 'https://blog.kanouk.com/posts/ux-draft']) {
  const denied = await lookup(url);
  assert.equal(denied.ok, false, `Forbidden or draft target must fail: ${url}`);
}
const externalResponse = await lookup('https://github.com/kanouk/kanouk.com');
const external = await externalResponse.json();
assert.equal(externalResponse.ok, true, JSON.stringify(external));
assert.ok(external.data.title && external.data.description && external.data.imageUrl, 'External page supplies OGP metadata');
console.log(JSON.stringify({ anonymous: anonymous.status, csrf: csrf.status, internal: internal.data, external: external.data }, null, 2));
