import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";
import { getAlbumMarkers } from "../../../utils/album-page";

export const GET: APIRoute = async ({params}) => {
 const {entry} = await getEmDashEntry('albums',params.slug ?? '');
 if (!entry || entry.data.status !== 'published') return new Response('Not Found',{status:404});
 return Response.json({markers:await getAlbumMarkers(entry.data.id)}, {headers:{'Cache-Control':'private, no-store'}});
};
