import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deferAdminBlocks} from './lazy-admin-blocks.mjs';
import {directPhosphorImports} from './direct-phosphor-imports.mjs';
test('optional declarative blocks preserve their API behind a Suspense boundary',()=>{
 const source=readFileSync(new URL('../node_modules/@emdash-cms/admin/dist/index.js',import.meta.url),'utf8');
 const next=deferAdminBlocks(source);
 assert.ok(!next.includes('import { BlockRenderer } from "@emdash-cms/blocks"'));
 assert.ok(next.includes('React.Suspense'));
 assert.ok(next.includes('module.BlockRenderer'));
 assert.throws(()=>deferAdminBlocks('changed upstream'),'upstream changes must fail the build');
});
test('named icon imports use the same actual exports without the all-icon barrel',async()=>{
 const result=directPhosphorImports('import { ArrowLeft as Back, IconContext, GithubLogo, } from "@phosphor-icons/react";');
 assert.ok(!result.includes('from "@phosphor-icons/react"'));
 assert.match(result,/ArrowLeft as Back/);
 assert.match(result,/dist\/lib\/context/);
 for(const match of result.matchAll(/import \{ (\w+) as \w+ \} from "([^"]+)"/g)) {
  assert.ok((await import(match[2]))[match[1]],match[2]);
 }
 assert.throws(()=>directPhosphorImports('import { Unknown } from "@phosphor-icons/react";'));
});
