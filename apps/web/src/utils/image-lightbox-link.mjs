export const PHOTO_SITE_LABEL = "カノログ フォト";
const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);

/** The quiet link under an enlarged image: where a linked image leads, in words. */
export function lightboxLinkLabel(href, pageOrigin) {
	let url;
	try {
		url = new URL(href, pageOrigin);
	} catch {
		return "リンク先を開く";
	}
	const samePage = url.origin === pageOrigin;
	if (url.pathname.startsWith("/p/") && (samePage || PHOTO_HOSTS.has(url.hostname))) return PHOTO_SITE_LABEL;
	return samePage ? "リンク先を開く" : `リンク先を開く（${url.hostname.replace(/^www\./, "")}）`;
}
