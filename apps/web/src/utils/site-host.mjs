// Keep in step with PHOTO_HOSTS in src/middleware.ts.
const PHOTO_HOSTS = new Set(["photos.kanouk.com", "photos-staging.kanouk.com"]);

export function isPhotoHost(hostname) {
	return PHOTO_HOSTS.has(hostname);
}
