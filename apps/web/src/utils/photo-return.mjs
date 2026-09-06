const MAX_AGE = 30 * 60 * 1000;

export function photoReturnKey(albumId) {
	return `yohaku:album-return:${albumId}`;
}

export function albumPhotoAnchor(photoId) {
	return `photo-${encodeURIComponent(photoId)}`;
}

// Storage is untrusted: it may be stale, manually edited, or from another album.
export function readPhotoReturn(raw, albumId, now = Date.now()) {
	try {
		const value = JSON.parse(raw);
		if (value?.albumId !== albumId || typeof value.photoId !== "string"
			|| !/^[A-Za-z0-9_-]{1,100}$/.test(value.photoId)
			|| !Number.isFinite(value.savedAt) || now < value.savedAt
			|| now - value.savedAt > MAX_AGE) return null;
		return value.photoId;
	} catch {
		return null;
	}
}
