// A cover's chosen crop, saved by the Android app in the image's meta. x and y (0-1) work
// like object-position and zoom scales around that same point, so any frame shape agrees.
const MAX_ZOOM = 3;

export function coverCrop(image) {
	const crop = image?.meta?.crop;
	if (![crop?.x, crop?.y, crop?.zoom].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
	return {
		x: Math.min(Math.max(crop.x, 0), 1),
		y: Math.min(Math.max(crop.y, 0), 1),
		zoom: Math.min(Math.max(crop.zoom, 1), MAX_ZOOM),
	};
}

export function coverCropStyle(crop) {
	const position = `${(crop.x * 100).toFixed(2)}% ${(crop.y * 100).toFixed(2)}%`;
	return `object-position:${position};transform-origin:${position};--cover-zoom:${crop.zoom.toFixed(3)}`;
}

/** The album list's image sizes, larger when zoomed so a close crop stays sharp. */
export function albumCoverSizes(crop) {
	const zoom = crop?.zoom ?? 1;
	if (zoom === 1) return "(max-width: 719px) calc(50vw - 1.3rem), (max-width: 1100px) 33vw, 18rem";
	const scale = zoom.toFixed(3);
	return `(max-width: 719px) calc((50vw - 1.3rem) * ${scale}), (max-width: 1100px) calc(33vw * ${scale}), calc(18rem * ${scale})`;
}
