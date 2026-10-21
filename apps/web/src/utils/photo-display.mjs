const SOURCE_MEDIA_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp|mp4|mov|m4v|avi|webm)$/i;

const textValue = (value) =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;

export const looksLikeSourceFilename = (value) => {
	const candidate = textValue(value);
	return Boolean(candidate && SOURCE_MEDIA_EXTENSION.test(candidate));
};

/**
 * A number a camera or phone gave the file ("PXL 20261019 022859167", "IMG_7133",
 * "DSC01234", "20240727_035027"), with or without the extension: not words anyone wrote.
 */
export const looksLikeCameraNumber = (value) => {
	const candidate = textValue(value)?.replace(SOURCE_MEDIA_EXTENSION, "");
	if (!candidate) return false;
	if (/^[\d\s_.~()-]+$/.test(candidate)) return true;
	return /^(?:PXL|IMG|MVIMG|VID|DSC[FN]?|DSCF|DJI|GOPR|GH\d|P\d|_?MG|PANO|Screenshot|スクリーンショット)[\s_-]*\d[\w\s.~()-]*$/i.test(candidate);
};

/** The title EmDash makes from an uploaded file name ("PXL_2026….jpg" → "PXL 2026…"). */
const titleFromFilename = (filename) =>
	textValue(filename)?.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();

/**
 * EmDash requires a photo title, so the SmugMug migration historically used
 * the source filename when SmugMug had no title. Keep that internal fallback
 * for content identity, but never present it as editorial copy.
 */
export const publicPhotoTitle = ({
	title,
	sourceSystem,
	sourceMetadata,
	imageFilename,
} = {}) => {
	const candidate = textValue(title);
	if (!candidate) return undefined;
	// Uploads from the organizer and the app: the title is only the file name.
	if (looksLikeCameraNumber(candidate)) return undefined;
	const fromFilename = titleFromFilename(imageFilename);
	if (fromFilename && candidate === fromFilename) return undefined;
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
