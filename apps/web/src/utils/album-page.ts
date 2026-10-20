import { sql, type Kysely } from "kysely";
import { normalizePhotoSort, photoOrderSql, sqlLiteral } from "./photo-sort.mjs";


export const ALBUM_PAGE_SIZE = 50;
const publicPhotos = (album: string) => sql`SELECT p.id,p.slug,live.data,
 json_extract(live.data,'$.captured_at') AS captured_at,
 coalesce(json_extract(live.data,'$.position'),0) AS position,
 json_extract(live.data,'$.image.filename') AS filename,
 json_extract(live.data,'$.caption') AS caption,
 p.created_at AS created_at, p.updated_at AS updated_at
 FROM ec_photos p JOIN revisions live ON live.id=p.live_revision_id
 WHERE p.status='published' AND p.deleted_at IS NULL
 AND json_extract(live.data,'$.album')=${album}`;
export type AlbumPhotoSort = { method?: unknown; direction?: unknown };
const SORT_COLUMNS = { captured: "unixepoch(captured_at)", position: "position", filename: "filename", caption: "caption", created: "created_at", updated: "updated_at", id: "id" };
/** The album's own order (SmugMug's per-gallery "Sort By"); capture time when unset. */
const orderedPhotos = (album: string, sort: AlbumPhotoSort = {}) => {
 const { method, direction } = normalizePhotoSort(sort.method, sort.direction);
 return sql`SELECT *,row_number() OVER (ORDER BY ${sql.raw(photoOrderSql(sqlLiteral(method), sqlLiteral(direction), SORT_COLUMNS))}) AS rn FROM (${publicPhotos(album)})`;
};

export async function getAlbumPage(album: string, requestedPage: number, photoId = '', sort: AlbumPhotoSort = {}, database?: Kysely<any>) {
 const db = database ?? await (await import("emdash/runtime")).getDb();
 const meta = await sql<{total:number; photoRow:number|null; mapCount:number}>`
 WITH ordered AS (${orderedPhotos(album, sort)}) SELECT count(*) AS total,
 max(CASE WHEN id=${photoId} THEN rn END) AS photoRow,
 sum(CASE WHEN json_type(data,'$.latitude') IN ('integer','real') AND json_type(data,'$.longitude') IN ('integer','real')
 AND json_extract(data,'$.latitude') BETWEEN -90 AND 90 AND json_extract(data,'$.longitude') BETWEEN -180 AND 180 THEN 1 ELSE 0 END) AS mapCount
 FROM ordered`.execute(db);
 const {total=0,photoRow=null,mapCount=0} = meta.rows[0] ?? {};
 const pageCount = Math.max(1,Math.ceil(total/ALBUM_PAGE_SIZE));
 const page = photoRow ? Math.ceil(photoRow/ALBUM_PAGE_SIZE) : Math.min(pageCount,Math.max(1,requestedPage));
 const rows = await sql<{id:string;slug:string;data:string}>`WITH ordered AS (${orderedPhotos(album, sort)})
 SELECT id,slug,data FROM ordered WHERE rn BETWEEN ${(page-1)*ALBUM_PAGE_SIZE+1} AND ${page*ALBUM_PAGE_SIZE} ORDER BY rn`.execute(db);
 return {total,page,pageCount,mapCount, photos:rows.rows.map(row=>({id:row.slug||row.id,data:{...JSON.parse(row.data),id:row.id}}))};
}

export async function getAlbumMarkers(album: string, database?: Kysely<any>) {
 const db = database ?? await (await import("emdash/runtime")).getDb();
 const result = await sql<{id:string;slug:string;latitude:number;longitude:number;title:string}>`
 SELECT id,slug,json_extract(data,'$.latitude') AS latitude,json_extract(data,'$.longitude') AS longitude,
 coalesce(nullif(json_extract(data,'$.caption'),''),json_extract(data,'$.title'),'写真を見る') AS title
 FROM (${publicPhotos(album)}) WHERE json_type(data,'$.latitude') IN ('integer','real')
 AND json_type(data,'$.longitude') IN ('integer','real')
 AND json_extract(data,'$.latitude') BETWEEN -90 AND 90
 AND json_extract(data,'$.longitude') BETWEEN -180 AND 180`.execute(db);
 return result.rows.map(row=>({latitude:row.latitude,longitude:row.longitude,title:row.title,href:`/p/${encodeURIComponent(row.slug||row.id)}`}));
}
