import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { parseEmbedUrl } from "../embed-url.mjs";
import { YohakuEmbedPreview } from "./embed-preview.mjs";
import { yohakuMergePreview, yohakuPreviewValue } from "./link-preview-auto.mjs";

// Admin editor behavior for Yohaku blocks, plugged into the EmDash admin
// through the `blockEditorExtensions` extension point
// (scripts/emdash-admin/patches/block-editor-runtime.mjs documents the API).

const LINK_PREVIEW_FIELDS = ["title", "description", "imageUrl"];
const SITE_ORIGIN = "https://blog.kanouk.com";
const PUBLIC_MEDIA_ORIGIN = "https://photos.kanouk.com";

function linkPreviewActive(block, formValues) {
	return block?.type === "yohaku.linkCard" || (block?.type === "yohaku.embed" && formValues.display === "link-card" && parseEmbedUrl(formValues.id).ok);
}

/** Fetches link card metadata while the URL is edited; manual fields win. */
function useLinkPreviewModal({ block, formValues, setFormValues, ui }) {
	const [linkPreviewState, setLinkPreviewState] = useState({ status: "idle", message: "" });
	const [linkPreviewRefreshNonce, setLinkPreviewRefreshNonce] = useState(0);
	const linkPreviewRequestRef = useRef(0);
	useEffect(() => {
		if (!linkPreviewActive(block, formValues) || !block.pluginId) return;
		const url = typeof formValues.id === "string" ? formValues.id.trim() : "";
		const requestVersion = ++linkPreviewRequestRef.current;
		const previewUrl = url.startsWith("/") && !url.startsWith("//") ? new URL(url, SITE_ORIGIN).href : url;
		let parsed;
		try {
			parsed = new URL(previewUrl);
		} catch {
			setLinkPreviewState(url ? { status: "error", message: "https URL またはサイト内パスを入力してください。" } : { status: "idle", message: "" });
			return;
		}
		if (parsed.protocol !== "https:") {
			setLinkPreviewState({ status: "error", message: "リンク情報は https URL から取得できます。" });
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			setLinkPreviewState({ status: "loading", message: "リンク情報を取得しています…" });
			try {
				const response = await fetch(`/_emdash/api/plugins/${block.pluginId}/link-preview`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					body: JSON.stringify({ url: previewUrl }),
					signal: controller.signal,
				});
				if (!response.ok) throw new Error(`リンク情報を取得できませんでした（${response.status}）`);
				const body = await response.json();
				const preview = body?.data?.url ? body.data : body?.data?.data ?? body;
				if (controller.signal.aborted || requestVersion !== linkPreviewRequestRef.current) return;
				setFormValues((previous) => yohakuMergePreview({ ...previous }, preview, previewUrl));
				setLinkPreviewState({ status: "success", message: "リンク情報を取得しました。必要なら編集できます。" });
			} catch (cause) {
				if (controller.signal.aborted || requestVersion !== linkPreviewRequestRef.current) return;
				setLinkPreviewState({ status: "error", message: cause instanceof Error ? cause.message : "リンク情報を取得できませんでした。手動で入力できます。" });
			}
		}, 500);
		return () => {
			clearTimeout(timer);
			controller.abort();
			linkPreviewRequestRef.current++;
		};
	}, [block?.type, block?.pluginId, formValues.id, formValues.display, linkPreviewRefreshNonce]);

	const active = linkPreviewActive(block, formValues);
	const isLinkCard = block?.type === "yohaku.linkCard";
	return {
		onOpen() {
			setLinkPreviewState({ status: "idle", message: "" });
			linkPreviewRequestRef.current++;
		},
		transformField(field) {
			if (!isLinkCard || !LINK_PREVIEW_FIELDS.includes(field.action_id)) return field;
			return { ...field, placeholder: yohakuPreviewValue({ ...formValues, [field.action_id]: "" }, field.action_id) || "空欄の場合は自動取得" };
		},
		after: [
			active && typeof formValues.id === "string" && formValues.id.trim() ? jsx(ui.Button, {
				type: "button",
				variant: "ghost",
				disabled: linkPreviewState.status === "loading",
				onClick: () => setLinkPreviewRefreshNonce((value) => value + 1),
				children: linkPreviewState.status === "loading" ? "リンク情報を取得中…" : "リンク情報を再取得",
			}, "refresh") : null,
			active && linkPreviewState.message ? jsx("p", {
				role: linkPreviewState.status === "error" ? "alert" : "status",
				className: linkPreviewState.status === "error" ? "text-sm text-kumo-danger" : "text-sm text-kumo-subtle",
				children: linkPreviewState.message,
			}, "message") : null,
			isLinkCard ? jsxs("div", {
				className: "rounded-md border border-kumo-line p-3 space-y-2",
				children: [jsx("p", { className: "text-xs text-kumo-subtle", children: "空欄の項目は自動取得します。手動入力した項目は、再取得しても変わりません。" }),
					jsx("strong", { children: yohakuPreviewValue(formValues, "title") || formValues.id || "リンクのプレビュー" }),
					jsx("p", { className: "text-sm text-kumo-subtle", children: yohakuPreviewValue(formValues, "description") }),
					yohakuPreviewValue(formValues, "imageUrl") ? jsx("img", {
						src: yohakuPreviewValue(formValues, "imageUrl"),
						alt: "リンク先のプレビュー画像",
						loading: "lazy",
						referrerPolicy: "no-referrer",
						className: "max-h-48 w-full rounded-md border border-kumo-line object-cover",
					}) : null],
			}, "preview") : null,
		],
	};
}

export const linkPreviewExtension = {
	id: "link-preview",
	useModal: useLinkPreviewModal,
};

/** yohaku.embed: validated URL and a click-to-load preview in both views. */
export const embedExtension = {
	id: "embed-preview",
	useModal({ block, formValues }) {
		if (block?.type !== "yohaku.embed") return null;
		return {
			before: jsx(YohakuEmbedPreview, { values: formValues }),
			canSubmit: parseEmbedUrl(formValues.id).ok,
		};
	},
	nodeView({ blockType, id, data }) {
		if (blockType !== "yohaku.embed") return null;
		return { below: jsx(YohakuEmbedPreview, { values: { ...data, id } }) };
	},
};

/** Album that a new photo block should start from: nearest preceding album block, else the first. */
export function findRelatedAlbumId(editor, beforePos) {
	let preceding = "";
	let first = "";
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name !== "pluginBlock" || node.attrs?.blockType !== "yohaku.album") return;
		const id = typeof node.attrs.id === "string" ? node.attrs.id.trim() : "";
		if (!id) return;
		if (!first) first = id;
		if (pos < beforePos) preceding = id;
	});
	return preceding || first;
}

function PhotoThumbnailPicker({ options, value, select }) {
	const photoOptions = options.filter((option) => typeof option.values?.imageUrl === "string" && option.values.imageUrl.length > 0);
	if (photoOptions.length === 0) return null;
	return jsx("div", {
		role: "listbox",
		"aria-label": "写真をサムネイルから選択",
		className: "mt-3 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto",
		children: photoOptions.map((option) => jsxs("button", {
			type: "button",
			role: "option",
			"aria-selected": value === option.value,
			onClick: () => select(option.value),
			className: value === option.value ? "overflow-hidden rounded-md border border-kumo-brand ring-2" : "overflow-hidden rounded-md border border-kumo-line hover:border-kumo-brand/50",
			// The admin CSS dropped `ring-kumo-brand/20` in 0.40; keep the same 20% brand ring.
			style: value === option.value ? { "--tw-ring-color": "color-mix(in oklab, var(--color-kumo-brand) 20%, transparent)" } : undefined,
			children: [jsx("img", {
				src: option.values.imageUrl,
				alt: "",
				loading: "lazy",
				className: "aspect-square w-full bg-kumo-tint object-cover",
			}), jsx("span", {
				className: "block truncate p-2 text-xs",
				children: `写真 ${option.label} を選択`,
			})],
		}, option.value)),
	});
}

/** yohaku.photo: thumbnail picker and the article's related album as the default album. */
export const photoPickerExtension = {
	id: "photo-picker",
	useModal() {
		return {
			fieldAddon({ field, options, value, select }) {
				if (field.optionsRoute !== "photos/options") return null;
				return jsx(PhotoThumbnailPicker, { options, value, select });
			},
		};
	},
	insertDefaults({ block, editor, insertPos, documentData }) {
		if (block.type !== "yohaku.photo") return undefined;
		const relatedAlbumId = typeof documentData?.related_album === "string" ? documentData.related_album : "";
		const albumId = relatedAlbumId.trim() ? relatedAlbumId.trim() : findRelatedAlbumId(editor, insertPos);
		return albumId ? { albumId } : undefined;
	},
};

function publicMediaOrigin(location) {
	return ["localhost", "127.0.0.1"].includes(location.hostname) || location.hostname.endsWith(".workers.dev") ? location.origin : PUBLIC_MEDIA_ORIGIN;
}

/** Thumbnail, title and public URL for photo, album and link card blocks. */
export function mediaSummary({ blockType, id, data }, location = globalThis.location) {
	const isPhoto = blockType === "yohaku.photo";
	const isAlbum = blockType === "yohaku.album";
	const isLinkCard = blockType === "yohaku.linkCard";
	if (!isPhoto && !isAlbum && !isLinkCard) return null;
	const imageUrl = isLinkCard ? yohakuPreviewValue({ ...data, id }, "imageUrl") : isPhoto && typeof data.imageUrl === "string" ? data.imageUrl : "";
	const title = isAlbum && typeof data.albumTitleSnapshot === "string" ? data.albumTitleSnapshot : isLinkCard ? yohakuPreviewValue({ ...data, id }, "title") : isPhoto && typeof data.caption === "string" && data.caption ? data.caption : isPhoto && typeof data.alt === "string" ? data.alt : "";
	let externalUrl;
	if (id && isPhoto) {
		const key = typeof data.photoSlug === "string" && data.photoSlug ? data.photoSlug : id;
		externalUrl = `${publicMediaOrigin(location)}/p/${encodeURIComponent(key)}`;
	} else if (id && isAlbum) {
		const key = typeof data.albumSlug === "string" && data.albumSlug ? data.albumSlug : id;
		externalUrl = `${publicMediaOrigin(location)}/albums/${encodeURIComponent(key)}`;
	}
	return { imageUrl, imageReferrerPolicy: isLinkCard ? "no-referrer" : undefined, title, externalUrl };
}

export const mediaSummaryExtension = {
	id: "media-summary",
	nodeView: (context) => mediaSummary(context),
};

export const blockEditorExtensions = [
	embedExtension,
	photoPickerExtension,
	linkPreviewExtension,
	mediaSummaryExtension,
];
