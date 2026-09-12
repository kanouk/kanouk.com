import { sql, type Kysely } from "kysely";

import { PluginRouteError } from "emdash";

// Read the editable revision, including a draft album move, without hydrating
// every photograph through the content API. Writes still use EmDash's API.
const effective = sql`SELECT p.id, p.slug, p.status, p.created_at, p.updated_at,
 p.published_at, p.version, p.locale, p.author_id, p.draft_revision_id, p.live_revision_id,
 coalesce(d.data, json_object('title',p.title,'caption',p.caption,'alt',p.alt,
 'image',json(p.image),'kind',p.kind,'album',p.album,'position',p.position,
 'captured_at',p.captured_at,'latitude',p.latitude,'longitude',p.longitude,
 'altitude',p.altitude,'source_metadata',json(p.source_metadata))) AS data
 FROM ec_photos p LEFT JOIN revisions d ON d.id=p.draft_revision_id
 WHERE p.deleted_at IS NULL`;

const flags = {
 "missing-caption": sql`trim(coalesce(json_extract(data,'$.caption'),''))=''`,
 "missing-alt": sql`trim(coalesce(json_extract(data,'$.alt'),''))='' AND trim(coalesce(json_extract(data,'$.image.alt'),''))=''`,
 "unpublished": sql`status != 'published'`,
 "location-unreviewed": sql`json_extract(data,'$.source_metadata.photo_organizer_upload')=1 AND coalesce(json_extract(data,'$.source_metadata.location_review'),'') != 'clean'`,
 "has-location": sql`json_extract(data,'$.latitude') IS NOT NULL OR json_extract(data,'$.longitude') IS NOT NULL OR json_extract(data,'$.altitude') IS NOT NULL OR EXISTS (SELECT 1 FROM json_tree(data,'$.source_metadata') WHERE lower(replace(replace(key,'_',''),'-','')) IN ('gps','gpslatitude','gpslongitude','gpsaltitude','latitude','longitude','altitude','location') AND value IS NOT NULL AND value!='')`,
};

export async function readAlbumCounts(database?: Kysely<any>) {
 const db = database ?? await (await import("emdash/runtime")).getDb();
 const result = await sql<{album: string; total: number; pending: number; maxPosition: number}>`
 WITH effective AS (${effective}) SELECT json_extract(data,'$.album') AS album,
 count(*) AS total, sum(CASE WHEN status!='published' OR (draft_revision_id IS NOT NULL AND draft_revision_id IS NOT live_revision_id) THEN 1 ELSE 0 END) AS pending,
 coalesce(max(cast(json_extract(data,'$.position') AS REAL)),0) AS maxPosition
 FROM effective GROUP BY json_extract(data,'$.album')`.execute(db);
 return { items: result.rows };
}

export async function readPhotoPage(input: unknown, database?: Kysely<any>) {
 const values = (input ?? {}) as Record<string, unknown>;
 const album = typeof values.album === 'string' ? values.album : '';
 const q = typeof values.q === 'string' ? values.q.trim().slice(0,200).toLowerCase() : '';
 const filter = typeof values.filter === 'string' ? values.filter : '';
 let offset = Number(values.offset ?? 0);
 const photo = typeof values.photo === "string" ? values.photo.slice(0,100) : "";
 if (!/^[A-Za-z0-9_-]{1,100}$/.test(album) || !Number.isSafeInteger(offset) || offset<0 || offset>1000000 || (filter && !Object.hasOwn(flags, filter))) {
  throw new PluginRouteError('VALIDATION_ERROR','Invalid photo query');
 }
 const where = sql`json_extract(data,'$.album')=${album}
 AND (${q}='' OR instr(lower(coalesce(json_extract(data,'$.title'),'') || ' ' || coalesce(json_extract(data,'$.caption'),'') || ' ' || coalesce(json_extract(data,'$.image.filename'),'')),${q})>0)
 AND (${filter ? flags[filter as keyof typeof flags] : sql`1=1`})`;
 const db = database ?? await (await import("emdash/runtime")).getDb();
 if (photo && !q && !filter && offset === 0) {
  const target = await sql<{rn:number}>`WITH effective AS (${effective}), ordered AS
   (SELECT id,row_number() OVER (ORDER BY coalesce(cast(json_extract(data,'$.position') AS REAL),0),id) AS rn FROM effective WHERE ${where})
   SELECT rn FROM ordered WHERE id=${photo}`.execute(db);
  if (target.rows[0]) offset = Math.floor((target.rows[0].rn-1)/50)*50;
 }
 const [page, count] = await Promise.all([
  sql<Record<string, any>>`WITH effective AS (${effective}) SELECT * FROM effective WHERE ${where}
   ORDER BY coalesce(cast(json_extract(data,'$.position') AS REAL),0),id LIMIT 50 OFFSET ${offset}`.execute(db),
  sql<{total:number}>`WITH effective AS (${effective}) SELECT count(*) AS total FROM effective WHERE ${where}`.execute(db),
 ]);
 const total = Number(count.rows[0]?.total ?? 0);
 return { total, offset, nextOffset: offset+50<total ? offset+50 : null, items: page.rows.map(row=>({
  id:row.id,type:'photos',slug:row.slug,status:row.status,data:JSON.parse(row.data),
  createdAt:row.created_at,updatedAt:row.updated_at,publishedAt:row.published_at,
  version:row.version,locale:row.locale,authorId:row.author_id,
  draftRevisionId:row.draft_revision_id,liveRevisionId:row.live_revision_id,
 })) };
}
