import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseXPostUrl } from '../plugins/yohaku-content-blocks/src/x-post-url.mjs';
import { parseEmbedUrl } from '../plugins/yohaku-content-blocks/src/embed-url.mjs';
import { linkCardText } from '../plugins/yohaku-content-blocks/src/link-card-text.mjs';
import { createEditor } from './emdash-admin/patch-kit.mjs';
import imagePresentationAttrs from './emdash-admin/patches/image-presentation-attrs.mjs';

test('legacy placeholder yields to OGP while actual manual titles remain', () => {
  assert.equal(linkCardText(' 関連記事 '), '');
  assert.equal(linkCardText(undefined), '');
  assert.equal(linkCardText('香家 三田店 (三田/担々麺)'), '香家 三田店 (三田/担々麺)');
});
test('reported legacy Spotify and Twitter URLs resolve to official targets', () => {
  assert.equal(parseEmbedUrl('https://open.spotify.com/intl-ja/track/6At8fG853JqHaZP72oONtA').embedUrl, 'https://open.spotify.com/embed/track/6At8fG853JqHaZP72oONtA');
  for (const host of ['twitter.com', 'x.com', 'mobile.twitter.com']) {
    assert.equal(parseXPostUrl(`https://${host}/nima_owji/status/1823388838279922166?s=20`).id, '1823388838279922166');
  }
  for (const url of ['https://evil.example/a/status/123', 'https://x.com.evil.example/a/status/123', 'https://user:pass@x.com/a/status/123', 'https://x.com:444/a/status/123', 'http://x.com/a/status/123', 'https://x.com/a', 'javascript:alert(1)']) assert.equal(parseXPostUrl(url), null);
});
test('legacy blocks reach provider renderers, and compact tracks reserve only 80px', () => {
  const index = readFileSync(new URL('../plugins/yohaku-content-blocks/src/astro/index.ts', import.meta.url), 'utf8');
  assert.match(index, /embed: LegacyEmbed/);
  const renderer = readFileSync(new URL('../plugins/yohaku-content-blocks/src/astro/LegacyEmbed.astro', import.meta.url), 'utf8');
  assert.match(renderer, /parseEmbedUrl\(node.url\)/);
  assert.match(renderer, /<DefaultEmbed node=\{node\}/);
  assert.doesNotMatch(renderer, /set:html/);
  assert.equal(parseEmbedUrl('https://open.spotify.com/track/6At8fG853JqHaZP72oONtA').height, 80);
  const stage = readFileSync(new URL('../plugins/yohaku-content-blocks/src/astro/Embed.astro', import.meta.url), 'utf8');
  assert.match(stage, /min-height: 0;/);
  const image = readFileSync(new URL('../src/components/YohakuPortableImage.astro', import.meta.url), 'utf8');
  assert.match(image, /node.visualStyle \?\? "photo-frame"/);
  // Links: legacy strings and EmDash 0.40 { href, blank } objects.
  assert.match(image, /typeof node\.link === "string"/);
  assert.match(image, /href=\{link\.href\}/);
  assert.match(image, /link\.blank \? "_blank"/);
});
test('actual installed editor converters preserve frames and links through the image schema', () => {
  const source = readFileSync(new URL('../node_modules/@emdash-cms/admin/dist/index.js', import.meta.url), 'utf8');
  assert.match(source, /visualStyle: \{ default: null \}/);
  assert.throws(() => imagePresentationAttrs.apply(createEditor(imagePresentationAttrs.id, 'upstream changed')));
  const marks = source.slice(source.indexOf('const SUPPORTED_PORTABLE_TEXT_DECORATORS'), source.indexOf('//#endregion', source.indexOf('const SUPPORTED_PORTABLE_TEXT_DECORATORS')));
  const converters = source.slice(source.indexOf('function generateKey()'), source.indexOf('function insertHtmlBlock('));
  const schemaStart = source.indexOf('addAttributes()', source.indexOf('draggable: true,', source.indexOf('//#region src/components/editor/Image')));
  const attrsStart = source.indexOf('src: { default: null },', schemaStart);
  const attrsEnd = source.indexOf('\n\t\t};', attrsStart);
  const attrs = vm.runInNewContext(`({${source.slice(attrsStart, attrsEnd)}})`);
  // Since EmDash 0.40 the converters sit next to TipTap extension/mark definitions.
  const ctx = vm.createContext({ Extension: { create: (config) => config }, Mark: { create: (config) => config } });
  const mediaUtilsStart = source.indexOf('//#region src/lib/media-utils.ts');
  const mediaUtils = mediaUtilsStart < 0 ? '' : source.slice(mediaUtilsStart, source.indexOf('//#endregion', mediaUtilsStart));
  vm.runInContext(mediaUtils + '\n' + marks + '\n' + converters, ctx);
  for (const visualStyle of ['photo-frame', 'border', 'shadow', 'none', undefined]) {
    ctx.blocks = [{ _type:'image', _key:'original', asset:{_ref:'media',url:'/photo.jpg'}, caption:'caption', displayWidth:600, alignment:'center', visualStyle, link:'https://photos.kanouk.com/p/example' }];
    const doc = vm.runInContext('portableTextToProsemirror(blocks)', ctx);
    // TipTap drops unknown attributes. Apply the actual image schema as well.
    doc.content[0].attrs = Object.fromEntries(Object.entries(doc.content[0].attrs).filter(([key]) => key in attrs));
    ctx.doc = doc;
    const [saved] = vm.runInContext('prosemirrorToPortableText(doc)', ctx);
    assert.equal(saved.visualStyle, visualStyle);
    // EmDash 0.40 owns image links and normalizes the legacy string form.
    assert.deepEqual(JSON.parse(JSON.stringify(saved.link)), { href: ctx.blocks[0].link });
    assert.equal(saved.displayWidth, 600);
    assert.equal(saved.caption, 'caption');
  }
});
