import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { yohakuContentBlocks } from "yohaku-content-blocks";
import { yohakuPhotoTools } from "./src/studio/plugin";

export default defineConfig({
	output: "server",
	server: { host: "127.0.0.1" },
	i18n: {
		defaultLocale: "ja",
		locales: ["ja"],
		routing: { prefixDefaultLocale: false },
	},
	// Keep original media in R2; responsive variants are produced at the edge.
	adapter: cloudflare({ imageService: "passthrough" }),
	cache: {
		provider: cacheCloudflare(),
	},
	routeRules: {
		"/": { maxAge: 300, swr: 86400 },
		"/posts": { maxAge: 300, swr: 86400 },
		"/posts/[slug]": { maxAge: 300, swr: 86400 },
		"/pages/[slug]": { maxAge: 300, swr: 86400 },
		"/category/[slug]": { maxAge: 300, swr: 86400 },
		"/tag/[slug]": { maxAge: 300, swr: 86400 },
		"/archives": { maxAge: 300, swr: 86400 },
		"/archives/[year]/[month]": { maxAge: 300, swr: 86400 },
		"/topics": { maxAge: 300, swr: 86400 },
		"/albums": { maxAge: 300, swr: 86400 },
		"/albums/[slug]": { maxAge: 300, swr: 86400 },
		"/p/[slug]": { maxAge: 300, swr: 86400 },
	},
	prefetch: {
		prefetchAll: false,
		defaultStrategy: "hover",
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
			emdash({
				siteUrl: "https://blog.kanouk.com",
				database: d1({ binding: "DB", session: "auto" }),
				storage: r2({ binding: "MEDIA" }),
				plugins: [
					formsPlugin(),
					yohakuContentBlocks(),
					yohakuPhotoTools(),
					cloudflareEmail({
						from: { email: "no-reply@mail.kanouk.com", name: "カノログ" },
					}),
				],
			}),
	],
	vite: {
		// Prebundle these SSR imports together. Discovering them after workerd has
		// loaded the server can invalidate its dependency chunk during local QA.
		optimizeDeps: { include: ["astro/app/manifest", "@emdash-cms/plugin-forms"] },
		server: {
			allowedHosts: [
				"blog.kanouk.com",
				"blog-staging.kanouk.com",
				"photos.kanouk.com",
				"photos-staging.kanouk.com",
			],
		},
	},
	devToolbar: { enabled: false },
});
