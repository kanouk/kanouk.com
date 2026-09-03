export const PHOTO_GRID_SIZE = Object.freeze({
	min: 112,
	max: 320,
	step: 16,
	defaultValue: 176,
	storageKey: "yohaku:photo-grid-size",
});

export function normalizePhotoGridSize(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return PHOTO_GRID_SIZE.defaultValue;
	const snapped =
		PHOTO_GRID_SIZE.min +
		Math.round((parsed - PHOTO_GRID_SIZE.min) / PHOTO_GRID_SIZE.step) *
			PHOTO_GRID_SIZE.step;
	return Math.min(PHOTO_GRID_SIZE.max, Math.max(PHOTO_GRID_SIZE.min, snapped));
}
