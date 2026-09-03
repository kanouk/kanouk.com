const SOURCE_MEDIA_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp|mp4|mov|m4v|avi|webm)$/i;

const textValue = (value) =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

export const looksLikeSourceFilename = (value) => {
	const candidate = textValue(value);
	return Boolean(candidate && SOURCE_MEDIA_EXTENSION.test(candidate));
};

/**
 * EmDash requires a photo title, so the SmugMug migration historically used
 * the source filename when SmugMug had no title. Keep that internal fallback
 * for content identity, but never present it as editorial copy.
 */
export const publicPhotoTitle = ({
	title,
	sourceSystem,
	sourceMetadata,
} = {}) => {
	const candidate = textValue(title);
	if (!candidate) return undefined;
	if (sourceSystem !== "smugmug") return candidate;

	const metadata = sourceMetadata && typeof sourceMetadata === "object"
		? sourceMetadata
		: {};
	const sourceFilename = textValue(metadata.source_filename);
	const sourceTitle = textValue(metadata.source_title);

	if (sourceFilename && candidate === sourceFilename) return sourceTitle;
	if (looksLikeSourceFilename(candidate)) return undefined;
	return candidate;
};
