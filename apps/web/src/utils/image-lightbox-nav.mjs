/**
 * Pure stepping rules for the article image lightbox, kept apart so node:test can run them.
 * Photos are stepped in document order without wrapping around.
 */

/** Which neighbours exist for the photo at `index` of `count`, and whether to show the counter. */
export function lightboxNeighbours(index, count) {
	const valid = Number.isInteger(index) && Number.isInteger(count) && index >= 0 && index < count;
	return {
		previous: valid && index > 0 ? index - 1 : null,
		next: valid && index < count - 1 ? index + 1 : null,
		counter: valid && count > 1 ? `${index + 1} / ${count}` : "",
	};
}

export const SWIPE_MIN_DISTANCE = 40;

/**
 * A finished one-finger gesture as a step: -1 (previous), 1 (next) or 0 (none).
 * Short or mostly vertical movements are left to taps and scrolling.
 */
export function swipeStep(dx, dy, minDistance = SWIPE_MIN_DISTANCE) {
	if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
	if (Math.abs(dx) < minDistance || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
	return dx < 0 ? 1 : -1;
}

/** Whether a photo whose box spans top..bottom is too far out of a viewport of `viewport` px to count as in view. */
export function needsScrollIntoView(top, bottom, viewport) {
	const height = bottom - top;
	if (!(height > 0) || !(viewport > 0)) return false;
	const visible = Math.min(bottom, viewport) - Math.max(top, 0);
	return visible < Math.min(height, viewport) * 0.25;
}
