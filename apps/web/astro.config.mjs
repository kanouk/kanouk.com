import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import { yohakuContentBlocks } from "yohaku-content-blocks";

export default defineConfig({
	output: "server",
	// Keep the pilot on R2 without enabling billable Cloudflare Images transforms.
	// Responsive variants are a post-migration optimization decision.
	adapter: cloudflare({ imageService: "passthrough" }),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
			emdash({
				database: d1({ binding: "DB", session: "auto" }),
				storage: r2({ binding: "MEDIA" }),
				plugins: [formsPlugin(), yohakuContentBlocks()],
			}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	vite: {
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
