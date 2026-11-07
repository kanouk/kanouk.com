import { jsx, jsxs } from "react/jsx-runtime";
import { articleImageStyles, resolveArticleImageStyle } from "../../../../src/utils/article-image-style.mjs";
import "../../../../src/styles/article-image-styles.css";

function ImageStylePicker({ image, updateAttributes }) {
	return jsxs("label", {
		className: "yohaku-image-style-field",
		children: [
			"画像スタイル",
			jsx("select", {
				className: "yohaku-image-style-picker",
				value: resolveArticleImageStyle(image.visualStyle),
				onChange: (event) => updateAttributes({ visualStyle: event.currentTarget.value }),
				children: articleImageStyles.map(({ value, label }) => jsx("option", { value, children: label }, value)),
			}),
		],
	});
}

export const imageStyleExtension = {
	ImageToolbar: ImageStylePicker,
	imagePreviewClass: (attrs) => `yohaku-image-preview style-${resolveArticleImageStyle(attrs.visualStyle)}`,
};
