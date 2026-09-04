import type { PluginDescriptor } from "emdash";

export function yohakuPhotoStudio(): PluginDescriptor {
	return {
		id: "yohaku-photo-studio",
		version: "1.0.0",
		entrypoint: new URL("./runtime.ts", import.meta.url).pathname,
		adminEntry: new URL("./admin.tsx", import.meta.url).pathname,
		adminPages: [
			{ path: "/", label: "Studio", icon: "aperture" },
			{ path: "/articles", label: "記事", icon: "file-text" },
			{ path: "/pages", label: "固定ページ", icon: "layout" },
			{ path: "/photos", label: "写真", icon: "image" },
			{ path: "/albums", label: "アルバム", icon: "images" },
			{ path: "/review", label: "要確認", icon: "alert-triangle" },
			{ path: "/media", label: "高度な管理", icon: "settings" },
		],
	};
}
