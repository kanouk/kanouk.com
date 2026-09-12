import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import { readPhotoPage, readAlbumCounts } from '../src/studio/photo-read.ts';
import { getAlbumPage, getAlbumMarkers } from '../src/utils/album-page.ts';

function fixture(count=120) {
 const raw = new DatabaseSync(':memory:');
 raw.exec(`CREATE TABLE revisions(id TEXT PRIMARY KEY,data TEXT);
 CREATE TABLE ec_photos(id TEXT PRIMARY KEY,slug TEXT,status TEXT,created_at TEXT,updated_at TEXT,published_at TEXT,version INTEGER,locale TEXT,author_id TEXT,draft_revision_id TEXT,live_revision_id TEXT,deleted_at TEXT,title TEXT,caption TEXT,alt TEXT,image TEXT,kind TEXT,album TEXT,position REAL,captured_at TEXT,latitude REAL,longitude REAL,altitude REAL,source_metadata TEXT);`);
 const insert = raw.prepare('INSERT INTO ec_photos(id,slug,status,version,locale,live_revision_id,title,caption,alt,image,album,position,captured_at,source_metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
 raw.exec('BEGIN');
 for(let i=0;i<count;i++) {
  const id=`p${String(i).padStart(5,'0')}`;
  const data={title:id,caption:i===110?'search target':'caption',alt:'alt',album:'a',position:(i+1)*1024,captured_at:'2026-01-01T00:00:00Z',image:{src:'/image.png'},latitude:35,longitude:135};
  raw.prepare('INSERT INTO revisions VALUES (?,?)').run(id,JSON.stringify(data));
  insert.run(id,id,'published',1,'ja',id,data.title,data.caption,data.alt,JSON.stringify(data.image),'a',data.position,data.captured_at,'{}');
 }
 raw.exec('COMMIT');
 const db=new Kysely({dialect:new SqliteDialect({database:{
  prepare(query){ const stmt=raw.prepare(query); return {reader:stmt.columns().length>0,all:(args)=>stmt.all(...args),run:(args)=>stmt.run(...args),iterate:(args)=>stmt.iterate(...args)}; },close(){raw.close();}
 }})});
 return {db,raw};
}

test('photo organizer transfers only 50 rows at 10,000 items and searches beyond the first page', async()=>{
 const {db}=fixture(10000);
 try {
  const first=await readPhotoPage({album:'a'},db);
  assert.equal(first.items.length,50); assert.equal(first.total,10000); assert.equal(first.nextOffset,50);
  const second=await readPhotoPage({album:'a',offset:first.nextOffset},db);
  assert.equal(second.items[0].id,'p00050');
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,100);
  const linked=await readPhotoPage({album:'a',photo:'p00110'},db);
  assert.equal(linked.items[0].id,'p00100');assert.equal(linked.nextOffset,150);
  const search=await readPhotoPage({album:'a',q:'search target'},db);
  assert.deepEqual(search.items.map(x=>x.id),['p00110']);
  assert.equal((await readPhotoPage({album:'empty'},db)).total,0);
  await assert.rejects(readPhotoPage({album:'a',offset:-1},db));
  await assert.rejects(readPhotoPage({album:'a',filter:'toString'},db));
 } finally {await db.destroy();}
});

test('admin uses draft album membership while public pages and maps expose only live revisions',async()=>{
 const {db,raw}=fixture();
 try {
  raw.prepare('INSERT INTO revisions VALUES (?,?)').run('draft',JSON.stringify({album:'b',title:'draft title',position:999,caption:'',source_metadata:{photo_organizer_upload:true,location_review:'unreviewed'},latitude:1,longitude:2}));
  raw.exec("UPDATE ec_photos SET draft_revision_id='draft' WHERE id='p00000'; UPDATE ec_photos SET status='draft' WHERE id='p00001'; UPDATE ec_photos SET deleted_at='now' WHERE id='p00002'");
  const counts=await readAlbumCounts(db);
  assert.equal(counts.items.find(x=>x.album==='a').total,118);
  assert.equal(counts.items.find(x=>x.album==='b').pending,1);
  const draft=await readPhotoPage({album:'b',filter:'location-unreviewed'},db);
  assert.equal(draft.items[0].data.title,'draft title');
  assert.equal((await readPhotoPage({album:'b',filter:'missing-caption'},db)).total,1);
  const first=await getAlbumPage('a',1,'',db);
  assert.equal(first.total,118);assert.equal(first.photos.length,50);
  assert.equal(first.photos[0].data.title,'p00000');
  const target=await getAlbumPage('a',1,'p00110',db);
  assert.equal(target.page,3);assert.ok(target.photos.some(p=>p.id==='p00110'));
  const markers=await getAlbumMarkers('a',db);
  assert.equal(markers.length,118); assert.equal(markers[0].latitude,35);
  assert.equal((await getAlbumMarkers('b',db)).length,0);
 }finally {await db.destroy();}
});
