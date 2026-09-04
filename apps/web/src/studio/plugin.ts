import type { PluginDescriptor } from "emdash";

export function yohakuPhotoTools(): PluginDescriptor {
	return {
		id: "yohaku-photo-tools",
		version: "1.0.0",
		entrypoint: new URL("./runtime.ts", import.meta.url).pathname,
		adminEntry: new URL("./admin.tsx", import.meta.url).pathname,
		adminPages: [
			{ path: "/organize", label: "写真を整理", icon: "images" },
		],
	};
}
