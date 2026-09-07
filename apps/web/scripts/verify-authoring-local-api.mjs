// Creates only local fixtures; no origin override or production credentials.
import assert from 'node:assert/strict';
import { ensureRelatedAlbumField } from './ensure-related-album-field.mjs';

if (!process.argv.includes('--confirm-local')) throw new Error('Requires --confirm-local; creates local authoring fixtures.');
const origin = 'http://127.0.0.1:4321';
const login = await fetch(`${origin}/_emdash/api/setup/dev-bypass?content=0&redirect=/_emdash/admin`, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Local session required');
async function api(path, options = {}) {
  return fetch(origin + path, { ...options, headers: { Cookie: cookie, Origin: origin, 'X-EmDash-Request': '1', 'Content-Type': 'application/json', ...options.headers } });
}
async function data(response) {
  const result = await response.json();
  assert.ok(response.ok && result.success, `${response.status}: ${JSON.stringify(result.error)}`);
  return result.data;
}
const schemaClient = {
  get: async path => ({ data: await data(await api(path)) }),
  post: async (path, body) => ({ data: await data(await api(path, { method: 'POST', body: JSON.stringify(body) })) }),
};
await ensureRelatedAlbumField(schemaClient, { apply: true });
const target = await data(await api('/_emdash/api/content/posts', {
  method: 'POST', body: JSON.stringify({ status: 'draft', locale: 'ja', data: {
    title: `公開状態の確認先 ${new Date().toISOString()}`, excerpt: '公開中だけ取得できる説明。', content: [],
  } }),
}));
const targetId = target.item.id;
await data(await api(`/_emdash/api/content/posts/${targetId}/publish?locale=ja`, { method: 'POST' }));
const content = [
  { _type: 'block', _key: 'intro', style: 'normal', markDefs: [], children: [{ _type: 'span', _key: 'intro-text', text: 'ローカル専用の操作確認です。本番の記事には保存しません。', marks: [] }] },
  { _type: 'yohaku.linkCard', _key: 'external', id: 'https://github.com/kanouk/kanouk.com' },
  { _type: 'yohaku.linkCard', _key: 'internal', id: 'https://blog.kanouk.com/posts/ux-article' },
  { _type: 'yohaku.linkCard', _key: 'publication', id: `https://blog.kanouk.com/posts/${targetId}` },
  { _type: 'yohaku.linkCard', _key: 'blocked', id: 'https://127.0.0.1/private' },
  { _type: 'yohaku.embed', _key: 'spotify', id: 'https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5', display: 'player', caption: 'Spotifyのキャプション保存確認' },
  { _type: 'yohaku.embed', _key: 'tiktok', id: 'https://www.tiktok.com/@scout2015/video/6718335390845095173', display: 'player', caption: 'TikTokのキャプション保存確認' },
];
const created = await data(await api('/_emdash/api/content/posts', {
  method: 'POST', body: JSON.stringify({ status: 'draft', locale: 'ja', data: {
    title: `関連アルバム・リンク・埋め込みの確認 ${new Date().toISOString()}`,
    excerpt: 'ローカル専用の統合テスト記事。', content, related_album: 'ux-album',
  } }),
}));
const id = created.item.id;
const previewUrl = key => `${origin}/_yohaku/link-preview?${new URLSearchParams({ collection: 'posts', entryId: id, blockKey: key })}`;
const entryPath = `/_emdash/api/content/posts/${encodeURIComponent(id)}?locale=ja`;
const loaded = await data(await api(entryPath));
assert.equal(loaded.item.data.related_album, 'ux-album');
assert.deepEqual(loaded.item.data.content, content, 'Native save must preserve embed attributes');
assert.equal((await fetch(`${origin}/posts/${id}`)).status, 404, 'Draft must not render publicly');
assert.equal((await fetch(previewUrl('external'))).status, 404, 'Draft cards cannot trigger public lookup');
await data(await api(`/_emdash/api/content/posts/${encodeURIComponent(id)}/publish?locale=ja`, { method: 'POST' }));
const published = await fetch(`${origin}/posts/${id}`);
assert.equal(published.status, 200);
const html = await published.text();
assert.ok(html.includes('Spotifyのキャプション保存確認') && html.includes('TikTokのキャプション保存確認'));
for (const key of ['external', 'internal']) {
  const response = await fetch(previewUrl(key));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
  const preview = await response.json();
  assert.ok(preview.metadata?.title && preview.metadata?.description && preview.metadata?.imageUrl, JSON.stringify(preview));
}
assert.equal((await fetch(previewUrl('missing'))).status, 404);
assert.equal((await fetch(previewUrl('spotify'))).status, 404, 'Player blocks cannot trigger link-card fetch');
assert.equal((await fetch(previewUrl('external') + '&url=https://example.com')).status, 400, 'Arbitrary target URL must be rejected');
const liveTarget = await (await fetch(previewUrl('publication'))).json();
assert.ok(liveTarget.metadata?.description && liveTarget.authoritative);
await data(await api(`/_emdash/api/content/posts/${targetId}/unpublish?locale=ja`, { method: 'POST' }));
const privateTarget = await (await fetch(previewUrl('publication'))).json();
assert.equal(privateTarget.state, 'negative');
assert.equal(privateTarget.authoritative, true);
assert.equal(privateTarget.metadata, undefined, 'Unpublished target cannot return old cached metadata');
const blocked = await fetch(previewUrl('blocked'));
assert.ok([200, 400].includes(blocked.status));
if (blocked.status === 200) assert.equal((await blocked.json()).state, 'negative');
const current = await data(await api(entryPath));
await data(await api(entryPath, { method: 'PUT', body: JSON.stringify({ _rev: current._rev, data: { related_album: null } }) }));
const clearedDraft = await data(await api(entryPath));
assert.equal(clearedDraft.item.data.related_album, null, 'Clearing the draft relation is saved');
assert.deepEqual(clearedDraft.item.data.content, content, 'Clearing relation never removes inserted blocks');
assert.equal((await api(entryPath, { method: 'PUT', body: JSON.stringify({ _rev: current._rev, data: { related_album: 'ux-album' } }) })).status, 409, 'Stale revision cannot overwrite changes');
const albumHtml = await (await fetch(`${origin}/albums/ux-album`)).text();
assert.ok(albumHtml.includes(`/posts/${id}`), 'Draft relation clear must leave the live reverse link intact');
await data(await api(`/_emdash/api/content/posts/${id}/publish?locale=ja`, { method: 'POST' }));
const clearedAlbumHtml = await (await fetch(`${origin}/albums/ux-album`)).text();
assert.ok(!clearedAlbumHtml.includes(`/posts/${id}`), 'Publishing the clear removes the relation-only reverse link');
console.log(JSON.stringify({ id, publicUrl: `${origin}/posts/${id}`, editorUrl: `${origin}/_emdash/admin/content/posts/${id}`, localOnly: true, publishedRelatedAlbum: null, draftRelatedAlbum: null, unpublishedTargetId: targetId }, null, 2));
