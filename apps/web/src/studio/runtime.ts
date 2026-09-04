import { definePlugin, PluginRouteError } from "emdash";

type AuditInput = {
	action?: "record" | "list";
	kind?: string;
	status?: string;
	targetIds?: string[];
	failures?: Array<{ id: string; reason: string }>;
	metadata?: Record<string, unknown>;
};

export function createPlugin() {
	return definePlugin({
		id: "yohaku-photo-studio",
		version: "1.0.0",
		capabilities: ["content:read", "content:write", "media:read", "media:write"],
		storage: {
			operations: { indexes: ["kind", "status", "createdAt"] },
		},
		routes: {
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
