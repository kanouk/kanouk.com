/** @param {string} slug */
export function photoPath(slug) {
	return `/p/${encodeURIComponent(slug)}`;
}
