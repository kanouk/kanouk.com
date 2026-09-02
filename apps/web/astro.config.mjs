import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
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
				siteUrl: "https://blog.kanouk.com",
				database: d1({ binding: "DB", session: "auto" }),
				storage: r2({ binding: "MEDIA" }),
				plugins: [
					formsPlugin(),
					yohakuContentBlocks(),
					cloudflareEmail({
						from: { email: "no-reply@mail.kanouk.com", name: "カノログ" },
					}),
				],
			}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Noto Sans JP",
			cssVariable: "--font-body",
			// Two deliberate weights keep the Japanese hierarchy clear without
			// multiplying every Unicode-subset request on long articles.
			weights: [400, 600],
			fallbacks: ["Hiragino Sans", "Yu Gothic", "sans-serif"],
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
