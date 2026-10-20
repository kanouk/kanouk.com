import { readAlbumCounts, readPhotoPage } from "./photo-read";
import { definePlugin, PluginRouteError } from "emdash";

type AuditInput = {
	action?: "record" | "list";
	kind?: string;
	status?: string;
	targetIds?: string[];
	failures?: Array<{ id: string; reason: string }>;
	metadata?: Record<string, unknown>;
};

export const ADMIN_GROUP = "写真";
/** Plugin storage document holding the manual album order (read by the public album list too). */
export const ALBUM_ORDER_ID = "album-order";

export function createPlugin() {
	return definePlugin({
		id: "yohaku-photo-tools",
		version: "1.0.0",
		capabilities: ["content:read", "content:write", "media:read", "media:write"],
		admin: {
			// `group` puts the page in the sidebar's 写真 folder, beside the albums and photos
			// collections, once they share that group (set from the organizer's setup card).
			pages: [{ path: "/organize", label: "写真を整理", icon: "images", group: ADMIN_GROUP } as { path: string; label: string; icon: string }],
			widgets: [{ id: "organize-shortcut", title: "写真を整理", size: "half" }],
		},
		storage: {
			operations: { indexes: ["kind", "status", "createdAt"] },
			// Site-level choices that are not content: the manual order of albums.
			settings: { indexes: [] },
		},
		routes: {
			"album-counts": { permission: "content:edit_any", handler: () => readAlbumCounts() },
			/**
			 * The owner's manual album order (SmugMug "Sort galleries: Manually").
			 * GET reads it; POST {ids} replaces it. The public album list follows it.
			 */
			"album-order": {
				permission: "content:edit_any",
				handler: async (ctx) => {
					if (ctx.request.method === "POST") {
						const ids = (ctx.input as { ids?: unknown } | null)?.ids;
						if (!Array.isArray(ids) || ids.length > 2000 || !ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id))) {
							throw new PluginRouteError("VALIDATION_ERROR", "Invalid album order", 400);
						}
						const record = { ids: [...new Set(ids as string[])], updatedAt: new Date().toISOString(), actorId: ctx.user?.id ?? null };
						await ctx.storage.settings.put(ALBUM_ORDER_ID, record);
						return { ids: record.ids };
					}
					const saved = (await ctx.storage.settings.get(ALBUM_ORDER_ID)) as { ids?: string[] } | null;
					return { ids: Array.isArray(saved?.ids) ? saved.ids : [] };
				},
			},
			"photo-page": { permission: "content:edit_any", handler: (ctx) => readPhotoPage(ctx.input) },
			operations: {
				permission: "content:edit_any",
				handler: async (ctx) => {
					const input = (ctx.input ?? {}) as AuditInput;
					if (input.action === "list") {
						const result = await ctx.storage.operations.query({
							orderBy: { createdAt: "desc" },
							limit: 50,
						});
						return {
							items: result.items.map((item) => ({
								id: item.id,
								...((item.data && typeof item.data === "object" ? item.data : {}) as Record<string, unknown>),
							})),
						};
					}
					if (input.action !== "record" || !input.kind || !input.status) {
						throw new PluginRouteError("VALIDATION_ERROR", "Invalid operation receipt", 400);
					}
					const id = crypto.randomUUID();
					const record = {
						kind: input.kind.slice(0, 80),
						status: input.status.slice(0, 40),
						targetIds: (input.targetIds ?? []).slice(0, 1000),
						failures: (input.failures ?? []).slice(0, 1000),
						metadata: input.metadata ?? {},
						actorId: ctx.user?.id ?? null,
						createdAt: new Date().toISOString(),
					};
					await ctx.storage.operations.put(id, record);
					return { id, ...record };
				},
			},
		},
	});
}

export default createPlugin;
