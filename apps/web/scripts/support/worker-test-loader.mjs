// Test-only module hooks: stub the EmDash Cloudflare handler (it needs the built
// site) and let Node resolve the Worker's extensionless TypeScript imports.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const STUB = "emdash-cloudflare-worker-stub:";

export async function resolve(specifier, context, next) {
	if (specifier === "@emdash-cms/cloudflare/worker") return { url: STUB, shortCircuit: true };
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const base = new URL(specifier, context.parentURL);
		if (!/\.[a-z]+$/i.test(base.pathname) && existsSync(fileURLToPath(base) + ".ts")) {
			return { url: pathToFileURL(fileURLToPath(base) + ".ts").href, shortCircuit: true };
		}
	}
	return next(specifier, context);
}

export async function load(url, context, next) {
	if (url === STUB) {
		return {
			format: "module",
			shortCircuit: true,
			source: `
				const handler = { fetch: async () => new Response("site", { status: 200 }) };
				export default handler;
				export const createScheduledHandler = () => async () => {};
				export class PluginBridge {}
			`,
		};
	}
	return next(url, context);
}
