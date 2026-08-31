/** Resolved media reference from getSiteSettings() */
export interface MediaReference {
	mediaId: string;
	alt?: string;
	url?: string;
}

export interface BlogSiteIdentitySettings {
	title?: string;
	tagline?: string;
	logo?: MediaReference;
	favicon?: MediaReference;
}

const DEFAULT_SITE_TITLE = "カノログ";
const DEFAULT_SITE_TAGLINE = "過去の記事と、インターネットに公開する写真の置き場";

export function resolveBlogSiteIdentity(settings?: BlogSiteIdentitySettings) {
	return {
		// The historical public name is intentional; the staging seed once used
		// the domain as a placeholder, which must not rename the blog at runtime.
		siteTitle: DEFAULT_SITE_TITLE,
		siteTagline: settings?.tagline ?? DEFAULT_SITE_TAGLINE,
		siteLogo: settings?.logo?.url ? settings.logo : null,
	};
}
