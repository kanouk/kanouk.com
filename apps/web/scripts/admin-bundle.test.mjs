import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deferAdminBlocks} from './lazy-admin-blocks.mjs';
import {directPhosphorImports} from './direct-phosphor-imports.mjs';
test('optional declarative blocks preserve their API behind a Suspense boundary',()=>{
 const source=readFileSync(new URL('../node_modules/@emdash-cms/admin/dist/index.js',import.meta.url),'utf8');
 const next=deferAdminBlocks(source);
 assert.ok(!/import \{[^}]*\} from "@emdash-cms\/blocks";/.test(next),'no eager import of the renderer entry');
 assert.match(next,/import \{ isSafePluginPagePath, normalizePluginPagePath \} from "@emdash-cms\/blocks\/server";/);
 assert.ok(next.includes('React.Suspense'));
 assert.ok(next.includes('module.BlockRenderer'));
 assert.throws(()=>deferAdminBlocks('changed upstream'),'upstream changes must fail the build');
 assert.throws(()=>deferAdminBlocks('import { BlockRenderer, unknownHelper } from "@emdash-cms/blocks";'),/lacks unknownHelper/);
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
test('the admin icon namespace keeps its API with only the icons it reads',async()=>{
 const {directPhosphorNamespace}=await import('./direct-phosphor-imports.mjs');
 const result=directPhosphorNamespace('import * as Icons from "@phosphor-icons/react";\nconst a = Icons.Table, b = Icons.Rows, c = Icons.Table; // ArrowIcons.tsx');
 assert.ok(!result.includes('import * as Icons'));
 assert.match(result,/const Icons = Object\.freeze\(\{ Rows: Icons\$Rows, Table: Icons\$Table \}\);/);
 for(const match of result.matchAll(/import \{ (\w+) as [\w$]+ \} from "([^"]+)"/g)) assert.ok((await import(match[2]))[match[1]],match[2]);
 assert.throws(()=>directPhosphorNamespace('import * as Icons from "@phosphor-icons/react"; Icons[name];'),/dynamic use/);
 assert.throws(()=>directPhosphorNamespace('import * as Icons from "@phosphor-icons/react"; render(Icons);'),/dynamic use/);
 const installed=readFileSync(new URL('../node_modules/@emdash-cms/admin/dist/index.js',import.meta.url),'utf8');
 assert.ok(!directPhosphorImports(installed).includes('from "@phosphor-icons/react"'));
});
