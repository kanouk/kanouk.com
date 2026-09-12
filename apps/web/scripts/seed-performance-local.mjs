// Creates synthetic pagination fixtures exclusively in the initialized local D1.
import {DatabaseSync} from 'node:sqlite';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
if(!process.argv.includes('--confirm-local-fixtures'))throw new Error('Pass --confirm-local-fixtures');
const directory=fileURLToPath(new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/',import.meta.url));
const files=readdirSync(directory).filter(f=>/^[a-f0-9]{64}\.sqlite$/.test(f));
if(files.length!==1)throw new Error('Expected one local D1');
const db=new DatabaseSync(join(directory,files[0]));
const album='ux-performance';
if(db.prepare('SELECT id FROM ec_albums WHERE id=?').get(album))throw new Error('Fixture already exists');
function add(collection,id,data) {
 const revision='revision-'+id;
 db.prepare('INSERT INTO revisions(id,collection,entry_id,data) VALUES(?,?,?,?)').run(revision,collection,id,JSON.stringify(data));
 const record={id,slug:id,status:'published',locale:'ja',published_at:'2026-09-12T00:00:00Z',draft_revision_id:revision,live_revision_id:revision,...data};
 const keys=Object.keys(record);
 db.prepare('INSERT INTO ec_'+collection+' ('+keys.map(k=>'"'+k+'"').join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...Object.values(record).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
}
const template=db.prepare("SELECT r.data FROM ec_photos p JOIN revisions r ON r.id=p.live_revision_id WHERE p.id='ux-photo-1'").get();
if(!template)throw new Error('Seed UX fixtures first');
const image=JSON.parse(template.data).image;
db.exec('BEGIN');
try {
 add('albums',album,{title:'性能検証用アルバム（ローカル限定）',description:'120件の合成データ'});
 for(let i=0;i<120;i++) add('photos','ux-perf-'+String(i).padStart(3,'0'),{title:'性能検証 '+i,caption:'性能検証 '+i,alt:'性能検証 '+i,image,album,position:(i+1)*1024,captured_at:'2026-01-01T00:00:00Z',kind:'image'});
 db.exec('COMMIT');console.log('Local fixture: ux-performance / 120 photos');
} catch(error) {db.exec('ROLLBACK');throw error;}finally{db.close();}
