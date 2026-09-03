function capturedTimestamp(photo) {
	const value = photo?.data?.captured_at;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function comparePhotosChronologically(left, right) {
	const leftTimestamp = capturedTimestamp(left);
	const rightTimestamp = capturedTimestamp(right);
	if (leftTimestamp !== undefined && rightTimestamp !== undefined && leftTimestamp !== rightTimestamp) {
		return leftTimestamp - rightTimestamp;
	}
	if (leftTimestamp === undefined && rightTimestamp !== undefined) return 1;
	if (leftTimestamp !== undefined && rightTimestamp === undefined) return -1;

	const leftPosition = Number.isFinite(left?.data?.position) ? left.data.position : 0;
	const rightPosition = Number.isFinite(right?.data?.position) ? right.data.position : 0;
	if (leftPosition !== rightPosition) return leftPosition - rightPosition;

	const leftId = String(left?.id ?? "");
	const rightId = String(right?.id ?? "");
	return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function sortPhotosChronologically(photos) {
	return [...photos].sort(comparePhotosChronologically);
}
