import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImageSource } from '../src/utils/image-source.ts';

test('external featured images use previewUrl without an internal media ID', () => {
 assert.equal(resolveImageSource({id:'', provider:'external-url', previewUrl:'https://i.gyazo.com/cover.png'}), 'https://i.gyazo.com/cover.png');
 assert.equal(resolveImageSource({id:'provider-id', provider:'external-url', previewUrl:''}), undefined);
});
test('existing source, legacy URL and internal media keys keep their precedence', () => {
 assert.equal(resolveImageSource({src:'/first.png',url:'/second.png',meta:{storageKey:'third'}}), '/first.png');
 assert.equal(resolveImageSource({url:'https://example.com/legacy.jpg'}), 'https://example.com/legacy.jpg');
 assert.equal(resolveImageSource({id:'id',meta:{storageKey:'posts/cover.jpg'}}), '/_emdash/api/media/file/posts%2Fcover.jpg');
 assert.equal(resolveImageSource({id:'id'}), '/_emdash/api/media/file/id');
 assert.equal(resolveImageSource('/kanolog-no-image.png'), '/kanolog-no-image.png');
});
test('missing or unsafe image URLs resolve to the card fallback', () => {
 for (const value of [null,undefined,{},'',{id:''}, ...['javascript:alert(1)','data:image/svg+xml,x','//evil.test/x','/\\evil.test/x','https://user:secret@example.com/x','https://','java\nscript:alert(1)'].map(previewUrl=>({provider:'external-url',previewUrl}))]) {
  assert.equal(resolveImageSource(value), undefined);
 }
});
