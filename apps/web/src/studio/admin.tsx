import { startPerformanceAudit } from "../client/performance-audit";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
	ContentEditorPanelContext,
	ContentEditorPanelExtension,
	ContentListColumnCellContext,
	ContentListColumnExtension,
} from "@emdash-cms/admin";
import { apiFetch, parseApiResponse } from "@emdash-cms/admin";
import {
	allContent,
	albumCounts, photoPage, albumPhotosForOperation, type AlbumCount, albumOrder, saveAlbumOrder, contentPage,
	createPhotoFromMedia,
	createAlbumDraft,
	getContent,
	publishDraft,
	recordOperation,
	PhotoToolsApiError,
	trashContent,
	unpublishContent,
	updateDraft,
	uploadPhotoMedia,
	type PhotoMediaItem,
	type ContentItem,
} from "./api";
import {
	applyBulkPatch,
	compareCapturedAt,
	isHiddenPhoto,
	mediaPreviewUrl,
	mediaUrl,
	needsLocationReview,
	photoReviewFlags,
	sparsePositions,
	textValue,
	type BulkTextMode,
	type ReviewFlag,
} from "./domain";
import {
	PUBLIC_IMAGE_WIDTHS,
	adjacentPhotoId,
	canCopyPublishedImageVariants,
	captionSelectionAfterSave,
	createUploadQueue,
	existingUploadIdentities,
	isUploadQueueRetryable,
	isUploadQueueSettled,
	dateTimeLocalInputValue,
	mergeEditableItems,
	preparePhotoDraftPatch,
	publicImageVariantPath,
	retryFailedUploadQueue,
	skipDuplicateUploads,
	updateUploadQueueItem,
	uploadFileKey,
	type UploadQueueItem,
} from "./organizer-workflow";
import { readPhotoMetadata, type PhotoMetadata } from "./photo-metadata";
import { looksLikeSourceFilename } from "../utils/photo-display.mjs";
import { normalizePhotoSort, photoComparator } from "../utils/photo-sort.mjs";
// Inlined and injected by the admin itself: a plain CSS import would be linked
// on every public page too, since the plugin registry is part of the site bundle.
import studioCss from "./studio.css?inline";

if (typeof document !== "undefined" && !document.getElementById("yohaku-photo-tools-css")) {
	const style = document.createElement("style");
	style.id = "yohaku-photo-tools-css";
	style.textContent = studioCss;
	document.head.append(style);
}
import { markAdminPresent } from "../client/admin-bar";

// The admin is never cached and always signed in: tell the public sites to show the admin bar.
if (typeof document !== "undefined") markAdminPresent();

const CORE_ROOT = "/_emdash/admin";
const ORGANIZER_ROOT = "/_emdash/admin/plugins/yohaku-photo-tools/organize";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ACCEPTED_IMAGE_INPUT = [...ACCEPTED_IMAGE_TYPES].join(",");
const MAX_UPLOAD_FILES = 500;
const NEW_ALBUM_FLAG = "yohaku-photo-tools:new-album";
const TILE_SHAPE_KEY = "yohaku-photo-tools:tile-shape";
type ViewOrder = "album" | "oldest" | "newest" | "name";
const VIEW_ORDER_LABELS: Record<ViewOrder, string> = {
	album: "アルバムの順",
	oldest: "撮影日時（古い順）",
	newest: "撮影日時（新しい順）",
	name: "ファイル名順",
};
const capturedTime = (item: ContentItem) => {
	const time = Date.parse(textValue(dataOf(item).captured_at));
	return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};

const UPLOAD_STAGE_LABELS: Record<UploadQueueItem<File, PhotoMediaItem>["stage"], string> = {
	queued: "待機中",
	"uploading-media": "アップロード中",
	"media-ready": "アップロード済み",
	"creating-photo": "アルバムに登録中",
	"photo-created": "追加済み",
	"skipped-duplicate": "アルバムにあるため省略",
	"failed-validation": "追加対象外",
	"failed-media": "アップロード失敗",
	"failed-photo": "登録失敗",
};

const FLAG_LABELS: Record<ReviewFlag, string> = {
	"missing-caption": "キャプションなし",
	"missing-alt": "altなし",
	"has-location": "位置情報あり",
	"location-unreviewed": "原本の位置情報未確認",
	"hidden": "非公開",
	"unpublished": "未公開",
};

function dataOf(item: ContentItem): Record<string, unknown> {
	return item.data ?? {};
}

function labelOf(item: ContentItem): string {
	const data = dataOf(item);
	return textValue(data.caption) || textValue(data.title) || item.slug || item.id;
}

/** A photo's own words, or "" when its title is only a file name or camera number (e.g. "PXL_….jpg", "27553"). */
function photoTitleOf(item: ContentItem): string {
	const data = dataOf(item);
	for (const value of [data.caption, data.title]) {
		const text = textValue(value);
		if (text && !looksLikeSourceFilename(text) && !/^[\d_-]+$/.test(text)) return text;
	}
	return "";
}

/** "2026/03/11 12:44" for tiles without a real title. */
function capturedLabelOf(item: ContentItem): string {
	return dateTimeLocalInputValue(dataOf(item).captured_at).replaceAll("-", "/").replace("T", " ");
}

function hasPendingChanges(item: ContentItem): boolean {
	if (isHiddenPhoto(dataOf(item))) return false;
	return item.status !== "published" || Boolean(
		item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId,
	);
}

function statusLabel(item: ContentItem): string {
	if (isHiddenPhoto(dataOf(item))) return "非公開";
	if (item.status !== "published") return "下書き";
	return hasPendingChanges(item) ? "変更あり" : "公開済み";
}

function photoEditHref(id: string): string {
	return `${CORE_ROOT}/content/photos/${encodeURIComponent(id)}?locale=ja`;
}

function albumEditHref(id: string): string {
	return `${CORE_ROOT}/content/albums/${encodeURIComponent(id)}?locale=ja`;
}

function organizerHref(albumId: string, photoId?: string): string {
	const params = new URLSearchParams({ album: albumId });
	if (photoId) params.set("photo", photoId);
	return `${ORGANIZER_ROOT}?${params}`;
}

function canChangeOrganizerContext(): boolean {
	if (typeof document === "undefined") return true;
	if (document.querySelector('[data-photo-tools-busy="true"]')) return false;
	if (!document.querySelector('[data-photo-tools-dirty="true"]')) return true;
	return window.confirm("下書き保存していない変更があります。破棄して移動しますか？");
}

function photoOrigin(): string {
	if (typeof window === "undefined") return "https://photos.kanouk.com";
	if (window.location.hostname === "blog.kanouk.com") return "https://photos.kanouk.com";
	if (window.location.hostname === "blog-staging.kanouk.com") return "https://photos-staging.kanouk.com";
	return window.location.origin;
}

function publicHref(item: ContentItem, kind: "album" | "photo"): string | null {
	if (!item.slug) return null;
	return `${photoOrigin()}${kind === "album" ? "/albums/" : "/p/"}${encodeURIComponent(item.slug)}`;
}

function Preview({ value, size = 160 }: { value: unknown; size?: number }) {
	const src = mediaPreviewUrl(value, size > 480 ? 768 : size > 320 ? 480 : 320) ?? mediaUrl(value);
	return src
		? <img className="photo-tools-thumb" src={src} alt="" width={size} height={size} loading="lazy" />
		: <span className="photo-tools-thumb photo-tools-thumb--empty">画像なし</span>;
}

type IconName = "back" | "plus" | "more" | "close" | "search" | "upload" | "left" | "right" | "star" | "image" | "check" | "albums" | "library";
const ICON_PATHS: Record<IconName, string> = {
	back: "M15 18l-6-6 6-6",
	plus: "M12 5v14M5 12h14",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	close: "M18 6L6 18M6 6l12 12",
	search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
	upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
	left: "M19 12H5M11 18l-6-6 6-6",
	right: "M5 12h14M13 6l6 6-6 6",
	star: "M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z",
	image: "M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01",
	check: "M5 12.5l4.5 4.5L19 7.5",
	albums: "M4 8h16v11H4zM7 5h10M8 13l2.5 2.5L16 10",
	library: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
};

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
	return <svg className="photo-tools-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}

const PHOTO_SORT_LABELS: Record<string, string> = {
	"date taken": "撮影日時",
	position: "手動",
	filename: "ファイル名",
	caption: "キャプション",
	"date uploaded": "追加日",
	"date modified": "更新日",
};

/**
 * Drag to reorder with a finger as well as a mouse (HTML drag and drop does not
 * work on phones). Touch starts after a long press so the page still scrolls;
 * with `immediate` (a reorder mode) the drag starts at once. Items carry
 * `data-reorder-index`; the page scrolls by itself near the top and bottom edge.
 */
function usePointerReorder({ enabled, immediate = false, touchOnly = false, onMove }: { enabled: boolean; immediate?: boolean; touchOnly?: boolean; onMove: (from: number, to: number) => void }) {
	const [dragging, setDragging] = useState<number | null>(null);
	const [over, setOver] = useState<number | null>(null);
	const onMoveRef = useRef(onMove);
	onMoveRef.current = onMove;
	const start = (event: React.PointerEvent, index: number) => {
		if (!enabled || event.button !== 0 || (touchOnly && event.pointerType === "mouse")) return;
		const origin = { x: event.clientX, y: event.clientY };
		let active = false;
		let target = index;
		let speed = 0;
		let frame = 0;
		let timer = 0;
		const indexAt = (x: number, y: number) => {
			const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-reorder-index]");
			return element ? Number(element.dataset.reorderIndex) : null;
		};
		const scroll = () => {
			if (speed) window.scrollBy(0, speed);
			frame = requestAnimationFrame(scroll);
		};
		const activate = () => {
			active = true;
			setDragging(index); setOver(index);
			navigator.vibrate?.(15);
			frame = requestAnimationFrame(scroll);
		};
		const move = (moveEvent: PointerEvent) => {
			if (!active) {
				if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) > 8) cleanup();
				return;
			}
			const found = indexAt(moveEvent.clientX, moveEvent.clientY);
			if (found !== null) { target = found; setOver(found); }
			const edge = 80;
			speed = moveEvent.clientY < edge ? -(edge - moveEvent.clientY) / 4 : moveEvent.clientY > window.innerHeight - edge ? (moveEvent.clientY - (window.innerHeight - edge)) / 4 : 0;
		};
		// While dragging, keep the browser from scrolling or selecting text under the finger.
		const blockTouch = (touchEvent: TouchEvent) => { if (active) touchEvent.preventDefault(); };
		const end = () => {
			const moved = active && target !== index;
			cleanup();
			if (moved) onMoveRef.current(index, target);
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			cancelAnimationFrame(frame);
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", end);
			document.removeEventListener("pointercancel", cleanup);
			document.removeEventListener("touchmove", blockTouch);
			if (active) {
				// Swallow the click that follows the drop.
				const swallow = (clickEvent: Event) => { clickEvent.stopPropagation(); clickEvent.preventDefault(); };
				document.addEventListener("click", swallow, { capture: true, once: true });
				window.setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 400);
			}
			active = false;
			setDragging(null); setOver(null);
		};
		document.addEventListener("pointermove", move);
		document.addEventListener("pointerup", end);
		document.addEventListener("pointercancel", cleanup);
		document.addEventListener("touchmove", blockTouch, { passive: false });
		if (immediate) activate();
		else timer = window.setTimeout(activate, 450);
	};
	return { dragging, over, start };
}

/** A small disclosure menu; closes on outside click, Escape, or choosing an item. */
function Menu({ label, children, align = "end" }: { label: string; children: React.ReactNode; align?: "start" | "end" }) {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const close = (event: Event) => {
			const menu = ref.current;
			if (!menu?.open) return;
			if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.contains(event.target as Node)) menu.open = false;
		};
		document.addEventListener("click", close);
		document.addEventListener("keydown", close);
		return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); };
	}, []);
	return <details ref={ref} className={`photo-tools-menu photo-tools-menu--${align}`}>
		<summary className="photo-tools-button photo-tools-button--icon" aria-label={label} title={label}><Icon name="more" /></summary>
		<div className="photo-tools-menu__panel" role="menu" onClick={() => { if (ref.current) ref.current.open = false; }}>{children}</div>
	</details>;
}

function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "warn" | "ok" | "danger" }) {
	return <span className={`photo-tools-badge photo-tools-badge--${tone}`}>{children}</span>;
}

function ErrorBox({ error }: { error: unknown }) {
	if (!error) return null;
	return <div className="photo-tools-alert photo-tools-alert--error" role="alert">
		{error instanceof Error ? error.message : "操作に失敗しました。"}
	</div>;
}

function PublicPhotoLinks({ photo }: { photo: ContentItem }) {
	const [copied, setCopied] = useState("");
	const [copyError, setCopyError] = useState("");
	const pageUrl = photo.status === "published" ? publicHref(photo, "photo") : null;
	const derivatives = canCopyPublishedImageVariants(photo)
		? PUBLIC_IMAGE_WIDTHS.flatMap((width) => {
			const path = publicImageVariantPath(dataOf(photo).image, width);
			return path ? [{ width, url: `${photoOrigin()}${path}` }] : [];
		})
		: [];
	const copy = async (label: string, value: string) => {
		setCopyError("");
		try {
			await navigator.clipboard.writeText(value);
			setCopied(label);
		} catch {
			setCopied("");
			setCopyError("URLをコピーできませんでした。ブラウザのクリップボード権限を確認してください。");
		}
	};
	if (!pageUrl) return null;
	return <section className="photo-tools-public-links" aria-label="公開URL">
		<h3>公開URL</h3>
		<div className="photo-tools-link-row">
			<span>Photoページ</span>
			<button type="button" className="photo-tools-button" onClick={() => copy("Photoページ", pageUrl)}>URLをコピー</button>
			<a className="photo-tools-button" href={pageUrl} target="_blank" rel="noreferrer">開く</a>
		</div>
		{derivatives.length > 0
			? <div className="photo-tools-size-links" aria-label="公開画像サイズ">
				<span>画像URL（WebP）</span>
				{derivatives.map(({ width, url }) => <button type="button" className="photo-tools-button" key={width} onClick={() => copy(`${width}px`, url)}>{width}px</button>)}
			</div>
			: !canCopyPublishedImageVariants(photo)
				? <p className="photo-tools-muted">未公開の変更があるため、画像URLは変更の公開後にコピーできます。</p>
				: <p className="photo-tools-muted">この写真では公開用のサイズ別URLを作成できません。</p>}
		{copied && <p className="photo-tools-copy-status" role="status">{copied}のURLをコピーしました。</p>}
		{copyError && <p className="photo-tools-alert photo-tools-alert--error" role="alert">{copyError}</p>}
	</section>;
}

type Failure = { id: string; reason: string };

function reasonOf(cause: unknown): string {
	if (cause instanceof PhotoToolsApiError && cause.status === 409) {
		return "別の変更と競合しました。再読込してからやり直してください。";
	}
	return cause instanceof Error ? cause.message : "不明なエラー";
}

/** A small OpenStreetMap view of where the photo was taken; Leaflet loads on first use. */
function LocationMap({ latitude, longitude }: { latitude: number; longitude: number }) {
	const ref = useRef<HTMLDivElement>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let map: { remove(): void } | undefined;
		let cancelled = false;
		void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([{ default: L }]) => {
			if (cancelled || !ref.current) return;
			const instance = L.map(ref.current, { scrollWheelZoom: false, attributionControl: false }).setView([latitude, longitude], 15);
			L.control.attribution({ prefix: false }).addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>').addTo(instance);
			L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(instance);
			L.circleMarker([latitude, longitude], { radius: 7, weight: 2, color: "#fff", fillColor: "#2271b1", fillOpacity: 0.95 }).addTo(instance);
			map = instance;
		}).catch(() => setFailed(true));
		return () => { cancelled = true; map?.remove(); };
	}, [latitude, longitude]);
	return failed
		? <p className="photo-tools-muted">地図を読み込めませんでした。</p>
		: <div ref={ref} className="photo-tools-map" role="img" aria-label="撮影場所の地図" />;
}

function PhotoInspector({
	photo,
	albums,
	busy,
	onSave,
	onPublish,
	onHide,
	onTrash,
	onDirtyChange,
	previousId,
	nextId,
	onNavigate,
	onClose,
	onMove,
	canMoveBack,
	canMoveForward,
	isCover,
	onMakeCover,
}: {
	photo: ContentItem;
	albums: ContentItem[];
	busy: boolean;
	onSave: (photo: ContentItem, patch: Record<string, unknown>) => Promise<boolean>;
	onPublish: (ids: string[]) => Promise<void>;
	onHide: (ids: string[], hidden: boolean) => Promise<void>;
	onTrash: (ids: string[]) => Promise<void>;
	onDirtyChange: (dirty: boolean) => void;
	previousId: string | null;
	nextId: string | null;
	onNavigate: (photoId: string) => void;
	onClose: () => void;
	onMove: (delta: -1 | 1) => void;
	canMoveBack: boolean;
	canMoveForward: boolean;
	isCover: boolean;
	onMakeCover: () => void;
}) {
	const saveInFlight = useRef(false);
	const [saving, setSaving] = useState(false);
	const [draft, setDraft] = useState(() => ({
		title: textValue(dataOf(photo).title),
		caption: textValue(dataOf(photo).caption),
		alt: textValue(dataOf(photo).alt),
		captured_at: dateTimeLocalInputValue(dataOf(photo).captured_at),
		album: textValue(dataOf(photo).album),
	}));
	useEffect(() => setDraft({
		title: textValue(dataOf(photo).title),
		caption: textValue(dataOf(photo).caption),
		alt: textValue(dataOf(photo).alt),
		captured_at: dateTimeLocalInputValue(dataOf(photo).captured_at),
		album: textValue(dataOf(photo).album),
	}), [photo.id, photo.updatedAt]);
	const dirty =
		draft.title !== textValue(dataOf(photo).title) ||
		draft.caption !== textValue(dataOf(photo).caption) ||
		draft.alt !== textValue(dataOf(photo).alt) ||
		draft.captured_at !== dateTimeLocalInputValue(dataOf(photo).captured_at) ||
		draft.album !== textValue(dataOf(photo).album);
	const preparedDraft = preparePhotoDraftPatch(dataOf(photo).captured_at, draft);
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	useEffect(() => {
		onDirtyChange(dirty);
		return () => onDirtyChange(false);
	}, [dirty, onDirtyChange]);
	const locationUnreviewed = needsLocationReview(dataOf(photo));
	const hidden = isHiddenPhoto(dataOf(photo));
	const latitude = dataOf(photo).latitude;
	const longitude = dataOf(photo).longitude;
	const position = typeof latitude === "number" && typeof longitude === "number" ? { latitude, longitude } : null;
	const saveDraft = async (targetId: string | null = null) => {
		if (saveInFlight.current) return;
		saveInFlight.current = true;
		setSaving(true);
		try {
			if (preparedDraft.dateError) return;
			const saved = await onSave(photo, preparedDraft.patch);
			if (targetId) onNavigate(captionSelectionAfterSave(photo.id, targetId, saved));
		} finally {
			saveInFlight.current = false;
			setSaving(false);
		}
	};
	const saveAndNavigate = async (targetId: string | null) => {
		if (!targetId || saveInFlight.current) return;
		if (dirty) {
			await saveDraft(targetId);
			return;
		}
		onNavigate(targetId);
	};
	const capturedDate = dateTimeLocalInputValue(dataOf(photo).captured_at).slice(0, 10).replaceAll("-", "/");
	return <aside className="photo-tools-inspector" aria-label="写真情報" data-photo-tools-dirty={dirty ? "true" : undefined}>
		<header className="photo-tools-inspector__header">
			<div>
				<h2 className={photoTitleOf(photo) ? undefined : "is-untitled"}>{photoTitleOf(photo) || "タイトル未設定"}</h2>
				<p>{capturedDate || "撮影日なし"}<span aria-hidden="true"> · </span><span className={`photo-tools-state photo-tools-state--${dirty ? "warn" : hasPendingChanges(photo) ? "warn" : hidden ? "muted" : "ok"}`}>{dirty ? "未保存" : statusLabel(photo)}</span>{isCover && <><span aria-hidden="true"> · </span>表紙</>}</p>
			</div>
			<button type="button" className="photo-tools-button photo-tools-button--icon photo-tools-button--ghost" onClick={onClose} aria-label="写真情報を閉じる" title="閉じる"><Icon name="close" /></button>
		</header>
		{/* The photo stays in view while the fields scroll; the arrows sit beside it, not on it. */}
		<div className="photo-tools-inspector__stage">
			<button type="button" className="photo-tools-button photo-tools-button--icon photo-tools-button--ghost" disabled={busy || saving || !previousId || Boolean(preparedDraft.dateError) || (dirty && (!draft.title.trim() || !draft.alt.trim()))} onClick={() => saveAndNavigate(previousId)} aria-label={dirty ? "保存して前の写真へ" : "前の写真"} title="前の写真"><Icon name="left" /></button>
			<div className="photo-tools-inspector__preview"><Preview value={dataOf(photo).image} size={480} /></div>
			<button type="button" className="photo-tools-button photo-tools-button--icon photo-tools-button--ghost" disabled={busy || saving || !nextId || Boolean(preparedDraft.dateError) || (dirty && (!draft.title.trim() || !draft.alt.trim()))} onClick={() => saveAndNavigate(nextId)} aria-label={dirty ? "保存して次の写真へ" : "次の写真"} title="次の写真"><Icon name="right" /></button>
		</div>
		<div className="photo-tools-inspector__body" key={photo.id}>
			<label>タイトル<input value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
			<label>キャプション<textarea value={draft.caption} disabled={busy} placeholder="キャプションを追加" onChange={(event) => setDraft({ ...draft, caption: event.target.value })} /></label>
			<label>代替テキスト<input value={draft.alt} disabled={busy} onChange={(event) => setDraft({ ...draft, alt: event.target.value })} /></label>
			<div className="photo-tools-field-row">
				<label>撮影日時<input type="datetime-local" value={draft.captured_at} disabled={busy} onChange={(event) => setDraft({ ...draft, captured_at: event.target.value })} /></label>
				<label>アルバム<select value={draft.album} disabled={busy} onChange={(event) => setDraft({ ...draft, album: event.target.value })}>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
			</div>
			{preparedDraft.dateError && <p className="photo-tools-alert photo-tools-alert--error" role="alert">{preparedDraft.dateError}</p>}
			<div className="photo-tools-location">
				{position
					? <>
						<span>撮影場所<a href={`https://www.openstreetmap.org/?mlat=${position.latitude}&mlon=${position.longitude}#map=16/${position.latitude}/${position.longitude}`} target="_blank" rel="noreferrer">地図を開く</a></span>
						<LocationMap latitude={position.latitude} longitude={position.longitude} />
						<small>公開するとアルバムの地図にも出ます</small>
					</>
					: <span>撮影場所<small>位置情報なし</small></span>}
			</div>
			<section className="photo-tools-inspector__section" aria-label="並びと表紙">
				<div className="photo-tools-button-group">
					<button type="button" className="photo-tools-button" disabled={busy || dirty || !canMoveBack} onClick={() => onMove(-1)}><Icon name="left" />前へ移動</button>
					<button type="button" className="photo-tools-button" disabled={busy || dirty || !canMoveForward} onClick={() => onMove(1)}>後ろへ移動<Icon name="right" /></button>
					<button type="button" className="photo-tools-button" disabled={busy || dirty || isCover} onClick={onMakeCover}><Icon name="star" />{isCover ? "表紙です" : "表紙にする"}</button>
				</div>
			</section>
			<section className="photo-tools-inspector__section" aria-label="公開">
				<div className="photo-tools-button-group">
					{!hidden && <button type="button" className="photo-tools-button" disabled={busy || dirty || locationUnreviewed || !hasPendingChanges(photo)} onClick={() => onPublish([photo.id])}>この写真を公開</button>}
					<button type="button" className="photo-tools-button" disabled={busy || dirty} onClick={() => onHide([photo.id], !hidden)}>{hidden ? "再び公開する" : "非公開にする"}</button>
					<a className="photo-tools-button" href={photoEditHref(photo.id)} onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>詳細編集</a>
				</div>
				{hidden && <p className="photo-tools-note">この写真は公開サイトに出ません。アルバムを公開しても非公開のままです。</p>}
				{locationUnreviewed && <p className="photo-tools-alert photo-tools-alert--error">原本の位置情報を確認するまで公開できません。</p>}
			</section>
			<PublicPhotoLinks photo={photo} />
			<section className="photo-tools-inspector__section photo-tools-inspector__danger">
				<button type="button" className="photo-tools-button photo-tools-button--danger" disabled={busy || dirty} onClick={() => onTrash([photo.id])}>この写真を削除</button>
			</section>
		</div>
		<footer className="photo-tools-inspector__footer">
			{dirty && <p className="photo-tools-note">変更を保存すると、公開や並べ替えができます。</p>}
			<nav className="photo-tools-caption-nav" aria-label="写真を順に編集">
				<button type="button" className="photo-tools-button" disabled={busy || saving || !previousId || Boolean(preparedDraft.dateError) || (dirty && (!draft.title.trim() || !draft.alt.trim()))} onClick={() => saveAndNavigate(previousId)}><Icon name="left" />{dirty ? "保存して前へ" : "前の写真"}</button>
				<button type="button" className="photo-tools-button photo-tools-button--primary" disabled={busy || saving || !dirty || Boolean(preparedDraft.dateError) || !draft.title.trim() || !draft.alt.trim()} onClick={() => saveDraft()}>{saving ? "保存中…" : "保存"}</button>
				<button type="button" className="photo-tools-button" disabled={busy || saving || !nextId || Boolean(preparedDraft.dateError) || (dirty && (!draft.title.trim() || !draft.alt.trim()))} onClick={() => saveAndNavigate(nextId)}>{dirty ? "保存して次へ" : "次の写真"}<Icon name="right" /></button>
			</nav>
		</footer>
	</aside>;
}

function BulkInspector({
	selected,
	albums,
	busy,
	onApply,
	onMove,
	onPublish,
	onHide,
	onTrash,
	onClear,
}: {
	selected: ContentItem[];
	albums: ContentItem[];
	busy: boolean;
	onApply: (field: "caption" | "alt", value: string, mode: BulkTextMode) => Promise<void>;
	onMove: (albumId: string) => Promise<void>;
	onPublish: (ids: string[]) => Promise<void>;
	onHide: (ids: string[], hidden: boolean) => Promise<void>;
	onTrash: (ids: string[]) => Promise<void>;
	onClear: () => void;
}) {
	const [field, setField] = useState<"caption" | "alt">("caption");
	const [mode, setMode] = useState<BulkTextMode>("overwrite");
	const [value, setValue] = useState("");
	const [target, setTarget] = useState("");
	return <aside className="photo-tools-inspector" aria-label="一括操作">
		<header className="photo-tools-inspector__header">
			<div><h2>{selected.length}点を選択中</h2><p>まとめて公開・非公開・移動・削除できます</p></div>
			<button type="button" className="photo-tools-button photo-tools-button--icon photo-tools-button--ghost" onClick={onClear} aria-label="選択を解除" title="選択を解除"><Icon name="close" /></button>
		</header>
		<div className="photo-tools-inspector__body">
			<section className="photo-tools-inspector__section" aria-label="公開">
				<h3>公開</h3>
				<div className="photo-tools-button-group">
					<button type="button" className="photo-tools-button" disabled={busy || !selected.some(hasPendingChanges)} onClick={() => onPublish(selected.map((photo) => photo.id))}>公開する</button>
					<button type="button" className="photo-tools-button" disabled={busy || selected.every((photo) => isHiddenPhoto(dataOf(photo)))} onClick={() => onHide(selected.map((photo) => photo.id), true)}>非公開にする</button>
					<button type="button" className="photo-tools-button" disabled={busy || !selected.some((photo) => isHiddenPhoto(dataOf(photo)))} onClick={() => onHide(selected.filter((photo) => isHiddenPhoto(dataOf(photo))).map((photo) => photo.id), false)}>再び公開する</button>
				</div>
			</section>
			<section className="photo-tools-inspector__section" aria-label="別のアルバムへ移動">
				<h3>別のアルバムへ移動</h3>
				<div className="photo-tools-inline-form">
					<select aria-label="移動先のアルバム" value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}><option value="">移動先を選ぶ</option>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select>
					<button type="button" className="photo-tools-button" disabled={busy || !target} onClick={() => onMove(target)}>移動</button>
				</div>
			</section>
			<section className="photo-tools-inspector__section" aria-label="文章をまとめて変更">
				<h3>文章をまとめて変更</h3>
				<div className="photo-tools-field-row">
					<label>項目<select value={field} disabled={busy} onChange={(event) => setField(event.target.value as "caption" | "alt")}><option value="caption">キャプション</option><option value="alt">代替テキスト</option></select></label>
					<label>方法<select value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as BulkTextMode)}><option value="overwrite">上書き</option><option value="prepend">先頭に追加</option><option value="append">末尾に追加</option></select></label>
				</div>
				<label>内容<textarea value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} /></label>
				<button type="button" className="photo-tools-button" disabled={busy || !value.trim()} onClick={async () => {
					if (mode === "overwrite" && !window.confirm(`${selected.length}点の${field === "caption" ? "キャプション" : "代替テキスト"}を同じ内容で上書きしますか？`)) return;
					await onApply(field, value, mode); setValue("");
				}}>下書きに反映</button>
			</section>
			<section className="photo-tools-inspector__section photo-tools-inspector__danger">
				<button type="button" className="photo-tools-button photo-tools-button--danger" disabled={busy} onClick={() => onTrash(selected.map((photo) => photo.id))}>{selected.length}点を削除</button>
				<p className="photo-tools-note">失敗した写真だけが選択されたまま残ります。</p>
			</section>
		</div>
	</aside>;
}

function AlbumOrganizer({
	album,
	albums,
	allPhotos,
	onAlbumUpdated,
	onPhotoUpdated,
	onPhotoAdded,
	onPhotoRemoved,
	onBusyChange,
	albumReady,
	onQuery, onRefresh, onFirstPage, firstOffset, onLoadMore, nextOffset, resultTotal, albumCount, onBack,
	pendingFiles, onPendingFilesTaken,
}: {
	album: ContentItem;
	albums: ContentItem[];
	allPhotos: ContentItem[];
	onAlbumUpdated: (item: ContentItem) => void;
	onPhotoUpdated: (item: ContentItem) => void;
	onPhotoAdded: (item: ContentItem) => void;
	onPhotoRemoved: (id: string) => void;
	onBusyChange: (busy: boolean) => void;
	albumReady: boolean;
	onQuery: (q: string, filter: string) => void;
	onRefresh: () => void;
	onFirstPage: () => void;
	firstOffset: number;
	onLoadMore: () => void;
	nextOffset: number | null;
	resultTotal: number;
	albumCount?: AlbumCount;
	onBack: () => void;
	/** Files chosen with the album list's "写真を追加" before this album was opened. */
	pendingFiles?: File[];
	onPendingFilesTaken?: () => void;
}) {
	const reorderInFlight = useRef(false);
	const requestedPhoto = useRef(typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("photo"));
	// The album's own order (its "並び順" setting), the same as the server's.
	const albumSort = normalizePhotoSort(dataOf(album).sort_method, dataOf(album).sort_direction);
	const albumPhotos = useMemo(() => allPhotos
		.filter((photo) => dataOf(photo).album === album.id)
		.toSorted(photoComparator(albumSort.method, albumSort.direction)), [allPhotos, album.id, albumSort.method, albumSort.direction]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<"" | ReviewFlag>("");
	const [busy, setBusy] = useState(false);
	const [dragId, setDragId] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [failures, setFailures] = useState<Failure[]>([]);
	const [touchedIds, setTouchedIds] = useState<Set<string>>(new Set());
	const [undoOrder, setUndoOrder] = useState<Array<{ id: string; position: number }> | null>(null);
	const [undoMove, setUndoMove] = useState<Array<{ id: string; album: string; position: number }> | null>(null);
	const [mobilePane, setMobilePane] = useState<"photos" | "info">("photos");
	const [photoDraftDirty, setPhotoDraftDirty] = useState(false);
	const [photoHydration, setPhotoHydration] = useState<{ identity: string; status: "loading" | "ready" | "error"; error?: unknown } | null>(null);
	const [photoHydrationRetry, setPhotoHydrationRetry] = useState(0);
	const photoHydrationSequence = useRef(0);
	const onPhotoUpdatedRef = useRef(onPhotoUpdated);
	const [uploadQueue, setUploadQueue] = useState<UploadQueueItem<File, PhotoMediaItem>[]>([]);
	const uploadMetadata = useRef(new WeakMap<File, PhotoMetadata>());
	const knownHashes = useRef(new Set<string>());
	const [uploading, setUploading] = useState(false);
	const [dragDepth, setDragDepth] = useState(0);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [locationErased, setLocationErased] = useState(0);
	const [selecting, setSelecting] = useState(false);
	const [sortOpen, setSortOpen] = useState(false);
	const [sortDraft, setSortDraft] = useState(albumSort);
	const [viewOrder, setViewOrder] = useState<ViewOrder>("album");
	const [tileShape, setTileShape] = useState<"square" | "original">(() => {
		try { return localStorage.getItem(TILE_SHAPE_KEY) === "original" ? "original" : "square"; } catch { return "square"; }
	});
	const moreButton = useRef<HTMLButtonElement>(null);
	const [albumDraft, setAlbumDraft] = useState({
		title: textValue(dataOf(album).title),
		description: textValue(dataOf(album).description),
	});

	useEffect(() => {
		onPhotoUpdatedRef.current = onPhotoUpdated;
	}, [onPhotoUpdated]);
	useEffect(() => {
		setSelectedId(null);
		setChecked(new Set());
		setTouchedIds(new Set());
		setUndoOrder(null);
		setUndoMove(null);
		setMobilePane("photos");
		setSelecting(false);
		setPhotoDraftDirty(false);
		setUploadQueue([]);
		setAlbumDraft({ title: textValue(dataOf(album).title), description: textValue(dataOf(album).description) });
		setMessage(""); setError(null); setFailures([]);
	}, [album.id]);
	useEffect(() => {
		if (selectedId && albumPhotos.some((photo) => photo.id === selectedId)) return;
		const requested = new URLSearchParams(window.location.search).get("photo");
		// Open a photo only when the URL asks for one; otherwise the grid gets the full width.
		if (requested && requested === requestedPhoto.current && albumPhotos.some((photo) => photo.id === requested)) {
			requestedPhoto.current = null;
			setSelectedId(requested);
			setMobilePane("info");
		}
	}, [album.id, albumPhotos, selectedId]);

	useEffect(() => {
		const timer = setTimeout(() => onQuery(search, filter), 250);
		return () => clearTimeout(timer);
	}, [search, filter, onQuery]);
	// Display order only; the album's own order (used by drag and drop) stays as it is.
	const visible = useMemo(() => {
		if (viewOrder === "album") return albumPhotos;
		if (viewOrder === "name") return albumPhotos.toSorted((left, right) => labelOf(left).localeCompare(labelOf(right), "ja", { numeric: true }));
		const direction = viewOrder === "newest" ? -1 : 1;
		return albumPhotos.toSorted((left, right) => {
			const a = capturedTime(left); const b = capturedTime(right);
			if (a === b) return 0;
			if (!Number.isFinite(a)) return 1;
			if (!Number.isFinite(b)) return -1;
			return (a - b) * direction;
		});
	}, [albumPhotos, viewOrder]);
	// Hand ordering is SmugMug's "Sort By: Manually": only when the album is set to 手動.
	const canReorder = !search && !filter && viewOrder === "album" && albumSort.method === "position";

	const selectedPhoto = allPhotos.find((photo) => photo.id === selectedId) ?? null;
	const checkedPhotos = allPhotos.filter((photo) => checked.has(photo.id));
	const inspectorPhoto = checkedPhotos.length === 1 ? checkedPhotos[0] : selectedPhoto;
	const inspectorIdentity = inspectorPhoto
		? `${inspectorPhoto.id}:${inspectorPhoto.draftRevisionId ?? ""}`
		: "";
	useEffect(() => {
		const sequence = ++photoHydrationSequence.current;
		if (!inspectorPhoto || checkedPhotos.length > 1) {
			setPhotoHydration(null);
			return;
		}
		if (inspectorPhoto._rev) {
			setPhotoHydration({ identity: inspectorIdentity, status: "ready" });
			return;
		}
		setPhotoHydration({ identity: inspectorIdentity, status: "loading" });
		getContent("photos", inspectorPhoto.id).then((result) => {
			if (photoHydrationSequence.current !== sequence) return;
			onPhotoUpdatedRef.current(result.item);
			setPhotoHydration({ identity: inspectorIdentity, status: "ready" });
		}).catch((cause) => {
			if (photoHydrationSequence.current !== sequence) return;
			setPhotoHydration({ identity: inspectorIdentity, status: "error", error: cause });
		});
		return () => { photoHydrationSequence.current += 1; };
	}, [inspectorPhoto?.id, inspectorPhoto?.draftRevisionId, Boolean(inspectorPhoto?._rev), checkedPhotos.length, inspectorIdentity, photoHydrationRetry]);
	const inspectorReady = Boolean(inspectorPhoto?._rev);
	const albumDraftDirty = albumDraft.title.trim() !== textValue(dataOf(album).title) || albumDraft.description.trim() !== textValue(dataOf(album).description);
	const pendingIds = new Set([...albumPhotos.filter(hasPendingChanges).map((photo) => photo.id), ...touchedIds]);
	const workspacePending = albumDraftDirty || hasPendingChanges(album) || pendingIds.size > 0 || Boolean(albumCount?.pending);
	const live = publicHref(album, "album");
	const operationLocked = busy || !albumReady || photoDraftDirty;
	// Load the next page by itself when the end of the grid comes into view.
	useEffect(() => {
		const button = moreButton.current;
		if (!button || nextOffset === null || operationLocked) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
		}, { rootMargin: "600px 0px" });
		observer.observe(button);
		return () => observer.disconnect();
	}, [nextOffset, operationLocked, onLoadMore, albumPhotos.length]);
	useEffect(() => {
		try { localStorage.setItem(TILE_SHAPE_KEY, tileShape); } catch { /* the choice still applies to this visit */ }
	}, [tileShape]);
	useEffect(() => {
		onBusyChange(busy);
		return () => onBusyChange(false);
	}, [busy, onBusyChange]);
	useEffect(() => {
		if (!albumDraftDirty && !busy) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [albumDraftDirty, busy]);

	useEffect(() => {
		if (!uploading) return;
		// The admin moves between pages without reloading, which beforeunload cannot see.
		const confirmLeave = (event: MouseEvent) => {
			const link = (event.target as Element | null)?.closest?.("a[href]");
			if (!link || link.getAttribute("target") === "_blank") return;
			if (!window.confirm("写真をアップロード中です。移動すると進み具合が見えなくなり、途中で止まることがあります。移動しますか？")) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		document.addEventListener("click", confirmLeave, true);
		return () => document.removeEventListener("click", confirmLeave, true);
	}, [uploading]);

	const touch = (id: string) => setTouchedIds((current) => new Set(current).add(id));
	const retainFailures = (items: Failure[]) => {
		setFailures(items);
		const photoIds = new Set(allPhotos.map((photo) => photo.id));
		setChecked(new Set(items.filter((item) => photoIds.has(item.id)).map((item) => item.id)));
	};

	const saveAlbumDraft = async () => {
		if (!albumDraftDirty || !albumDraft.title.trim() || !album._rev) return;
		setBusy(true); setError(null); setFailures([]); setMessage("アルバム情報を保存中…");
		try {
			const result = await updateDraft("albums", album.id, album._rev, { title: albumDraft.title.trim(), description: albumDraft.description.trim() });
			onAlbumUpdated(result.item); setMessage("アルバム情報を下書き保存しました");
		} catch (cause) { setError(new Error(reasonOf(cause))); setMessage(""); }
		finally { setBusy(false); }
	};

	const savePhoto = async (photo: ContentItem, patch: Record<string, unknown>): Promise<boolean> => {
		if (!photo._rev) return false;
		setBusy(true); setError(null); setMessage("保存中…"); setFailures([]);
		try {
			let normalized = patch;
			const targetAlbum = textValue(patch.album);
			if (targetAlbum && targetAlbum !== dataOf(photo).album) {
				const targetPhotos = await allContent("photos", { fieldFilters: { album: targetAlbum }, orderBy: "position", order: "asc" });
				normalized = { ...patch, position: Math.max(0, ...targetPhotos.map((item) => Number(dataOf(item).position) || 0)) + 1024 };
				setUndoMove([{ id: photo.id, album: textValue(dataOf(photo).album), position: Number(dataOf(photo).position) || 0 }]);
			}
			const result = await updateDraft("photos", photo.id, photo._rev, normalized);
			onPhotoUpdated(result.item); touch(photo.id); setMessage("写真の下書きを保存しました");
			if (targetAlbum && targetAlbum !== album.id) {
				setSelectedId(null);
				setChecked((current) => {
					const next = new Set(current);
					next.delete(photo.id);
					return next;
				});
			}
			return true;
		} catch (cause) {
			setError(new Error(cause instanceof PhotoToolsApiError && cause.status === 409
				? "別の変更と競合しました。入力は保持されています。内容を確認して、もう一度保存してください。"
				: reasonOf(cause)));
			setMessage("");
			return false;
		}
		finally { setBusy(false); }
	};

	const publishMany = async (ids: string[]) => {
		const targets = [...new Set(ids)].filter(Boolean);
		if (!targets.length || photoDraftDirty || !albumReady) return;
		setBusy(true); setError(null); setFailures([]); setMessage(`${targets.length}点を公開中…`);
		const failed: Failure[] = [];
		for (const id of targets) {
			const photo = allPhotos.find((item) => item.id === id);
			if (photo && isHiddenPhoto(dataOf(photo))) continue;
			if (photo && needsLocationReview(dataOf(photo))) {
				failed.push({ id, reason: "原本の位置情報が未確認です" });
				continue;
			}
			try { const result = await publishDraft("photos", id); onPhotoUpdated(result.item); }
			catch (cause) { failed.push({ id, reason: reasonOf(cause) }); }
		}
		setTouchedIds((current) => new Set([...current].filter((id) => failed.some((failure) => failure.id === id))));
		retainFailures(failed);
		await recordOperation({ kind: "photo-publish", status: failed.length ? "partial" : "complete", targetIds: targets, failures: failed }).catch(() => undefined);
		setMessage(failed.length ? `${targets.length - failed.length}点を公開・${failed.length}点が失敗` : `${targets.length}点を公開しました`);
		setBusy(false);
	};

	const persistOrder = async (next: ContentItem[]) => {
		if (photoDraftDirty || !albumReady || reorderInFlight.current) return;
		reorderInFlight.current = true;
		setBusy(true); setError(null); setFailures([]); setMessage("並び順を保存中…");
		// Positions run the way the album shows them: highest first when its manual order is descending.
		const descending = albumSort.direction === "desc";
		let positions = next.map(photo => Number(dataOf(photo).position) || 0).sort((a,b) => descending ? b-a : a-b);
		if (new Set(positions).size !== positions.length) {
			try {
				const full = await albumPhotosForOperation(album.id);
				const selected = new Set(next.map(photo => photo.id));
				let cursor = 0;
				next = full.map(photo => selected.has(photo.id) ? next[cursor++] : photo);
				positions = descending ? sparsePositions(next.length).toReversed() : sparsePositions(next.length);
			} catch (cause) { setError(cause); setBusy(false); reorderInFlight.current = false; return; }
		}
		const changed = next.flatMap((photo, index) => Number(dataOf(photo).position) === positions[index] ? [] : [{ photo, position: positions[index] }]);
		setUndoOrder(changed.map(({ photo }) => ({ id: photo.id, position: Number(dataOf(photo).position) || 0 })));
		const failed: Failure[] = [];
		const succeeded: Array<{ id: string; position: number }> = [];
		for (const { photo, position } of changed) {
			try {
				const current = await getContent("photos", photo.id);
				// An order change alone goes live at once (as in SmugMug); a photo with other unpublished edits stays a draft.
				const liveOnly = current.item.status === "published" && !hasPendingChanges(current.item) && !isHiddenPhoto(dataOf(current.item));
				let result = await updateDraft("photos", photo.id, current._rev, { position });
				if (liveOnly) result = await publishDraft("photos", photo.id);
				else touch(photo.id);
				onPhotoUpdated(result.item);
				succeeded.push({ id: photo.id, position: Number(dataOf(photo).position) || 0 });
			}
			catch (cause) { failed.push({ id: photo.id, reason: reasonOf(cause) }); }
		}
		if (failed.length) {
			setUndoOrder(null);
			for (const item of succeeded.toReversed()) {
				try { const current = await getContent("photos", item.id); const result = await updateDraft("photos", item.id, current._rev, { position: item.position }); onPhotoUpdated(result.item); }
				catch (cause) { failed.push({ id: item.id, reason: `元の並び順への復元も失敗しました: ${reasonOf(cause)}` }); }
			}
		}
		retainFailures(failed);
		await recordOperation({ kind: "album-reorder", status: failed.length ? "partial" : "complete", targetIds: changed.map(({ photo }) => photo.id), failures: failed, metadata: { albumId: album.id } }).catch(() => undefined);
		setMessage(failed.length ? `並び順を完了できなかったため、保存済みの変更を元へ戻しました（${failed.length}件を確認してください）` : "並び順を保存しました");
		setBusy(false);
		reorderInFlight.current = false;
		onRefresh();
	};

	const moveAt = (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= albumPhotos.length || operationLocked) return;
		const next = [...albumPhotos]; [next[index], next[target]] = [next[target], next[index]]; void persistOrder(next);
	};

	const moveSelected = async (targetAlbumId: string) => {
		const targets = checkedPhotos;
		if (!targets.length || !targetAlbumId || targetAlbumId === album.id || operationLocked) return;
		setBusy(true); setError(null); setFailures([]); setMessage("写真を移動中…");
		let targetPhotos: ContentItem[];
		try {
			targetPhotos = await allContent("photos", { fieldFilters: { album: targetAlbumId }, orderBy: "position", order: "asc" });
		} catch (cause) {
			setError(new Error(reasonOf(cause))); setMessage(""); setBusy(false); return;
		}
		let position = Math.max(0, ...targetPhotos.map((photo) => Number(dataOf(photo).position) || 0));
		const previous = targets.map((photo) => ({ id: photo.id, album: textValue(dataOf(photo).album), position: Number(dataOf(photo).position) || 0 }));
		const failed: Failure[] = [];
		for (const photo of targets) {
			try { position += 1024; const current = await getContent("photos", photo.id); const result = await updateDraft("photos", photo.id, current._rev, { album: targetAlbumId, position }); onPhotoUpdated(result.item); touch(photo.id); }
			catch (cause) { failed.push({ id: photo.id, reason: reasonOf(cause) }); }
		}
		setUndoMove(previous.filter((item) => !failed.some((failure) => failure.id === item.id)));
		retainFailures(failed);
		await recordOperation({ kind: "photo-move", status: failed.length ? "partial" : "complete", targetIds: targets.map((photo) => photo.id), failures: failed, metadata: { fromAlbumId: album.id, toAlbumId: targetAlbumId } }).catch(() => undefined);
		setMessage(failed.length ? `${targets.length - failed.length}点を移動・${failed.length}点が失敗` : `${targets.length}点を移動しました（下書き）`); setBusy(false);
	};

	const applyBulk = async (field: "caption" | "alt", value: string, mode: BulkTextMode) => {
		if (operationLocked) return;
		setBusy(true); setError(null); setFailures([]); setMessage("一括編集を保存中…");
		const failed: Failure[] = [];
		for (const photo of checkedPhotos) {
			try { const current = await getContent("photos", photo.id); const data = applyBulkPatch(dataOf(current.item), { [field]: { value, mode } }); const result = await updateDraft("photos", photo.id, current._rev, { [field]: data[field] }); onPhotoUpdated(result.item); touch(photo.id); }
			catch (cause) { failed.push({ id: photo.id, reason: reasonOf(cause) }); }
		}
		retainFailures(failed);
		await recordOperation({ kind: "bulk-text-edit", status: failed.length ? "partial" : "complete", targetIds: checkedPhotos.map((photo) => photo.id), failures: failed, metadata: { field, mode } }).catch(() => undefined);
		setMessage(failed.length ? `${checkedPhotos.length - failed.length}点を保存・${failed.length}点が失敗` : `${checkedPhotos.length}点の下書きを保存しました`); setBusy(false);
	};

	const restore = async (items: Array<{ id: string; album?: string; position: number }>, kind: "order" | "move") => {
		if (operationLocked) return;
		setBusy(true); setFailures([]); const failed: Failure[] = [];
		for (const item of items) {
			try { const current = await getContent("photos", item.id); const result = await updateDraft("photos", item.id, current._rev, { ...(item.album ? { album: item.album } : {}), position: item.position }); onPhotoUpdated(result.item); touch(item.id); }
			catch (cause) { failed.push({ id: item.id, reason: reasonOf(cause) }); }
		}
		kind === "order" ? setUndoOrder(null) : setUndoMove(null); retainFailures(failed);
		setMessage(failed.length ? `${failed.length}点を元に戻せませんでした` : kind === "order" ? "並び順を元に戻しました" : "写真を元のアルバムへ戻しました"); setBusy(false);
	};

	const publishWorkspace = async () => {
		if (!workspacePending || operationLocked) return;
		setBusy(true); setError(null); setFailures([]); setMessage("アルバムの変更を公開中…");
		const failed: Failure[] = []; let publishedPhotos = 0; let albumSaveFailed = false;
		let operationPhotos: ContentItem[];
		try { operationPhotos = await albumPhotosForOperation(album.id); }
		catch (cause) { setError(cause); setBusy(false); return; }
		const operationPendingIds = new Set([...operationPhotos.filter(hasPendingChanges).map(photo=>photo.id), ...pendingIds]);
		if (albumDraftDirty) {
			try {
				if (!album._rev) throw new Error("アルバムの編集情報を再読込してください。");
				const result = await updateDraft("albums", album.id, album._rev, { title: albumDraft.title.trim(), description: albumDraft.description.trim() }); onAlbumUpdated(result.item);
			}
			catch (cause) { failed.push({ id: album.id, reason: reasonOf(cause) }); albumSaveFailed = true; }
		}
			if (!albumSaveFailed) {
				for (const id of operationPendingIds) {
					const photo = operationPhotos.find((item) => item.id === id);
					if (photo && isHiddenPhoto(dataOf(photo))) continue;
					if (photo && needsLocationReview(dataOf(photo))) {
						failed.push({ id, reason: "原本の位置情報が未確認です" });
						continue;
					}
					try { const result = await publishDraft("photos", id); onPhotoUpdated(result.item); publishedPhotos += 1; }
				catch (cause) { failed.push({ id, reason: reasonOf(cause) }); }
			}
		}
		if (!failed.length) {
			try { const result = await publishDraft("albums", album.id); onAlbumUpdated(result.item); }
			catch (cause) { failed.push({ id: album.id, reason: reasonOf(cause) }); }
		}
		setTouchedIds(new Set(failed.filter((failure) => failure.id !== album.id).map((failure) => failure.id)));
		retainFailures(failed);
		await recordOperation({ kind: "album-publish", status: failed.length ? "partial" : "complete", targetIds: [album.id, ...operationPendingIds], failures: failed, metadata: { albumId: album.id, publishedPhotos } }).catch(() => undefined);
		setMessage(failed.length ? `${publishedPhotos}点を公開しましたが、${failed.length}件が失敗しました` : `アルバムと写真${publishedPhotos}点を公開しました`); setBusy(false);
	};

	const setHidden = async (ids: string[], hidden: boolean) => {
		if (!ids.length || operationLocked) return;
		setBusy(true); setError(null); setFailures([]); setMessage(hidden ? "非公開にしています…" : "公開しています…");
		const failed: Failure[] = [];
		for (const id of ids) {
			try {
				const current = await getContent("photos", id);
				const { hidden: _previous, ...metadata } = (dataOf(current.item).source_metadata ?? {}) as Record<string, unknown>;
				let result = await updateDraft("photos", id, current._rev, { source_metadata: hidden ? { ...metadata, hidden: true } : metadata });
				// Hiding takes the photo off the public site now; showing it again publishes it.
				if (hidden && current.item.status === "published") {
					await unpublishContent("photos", id);
					// The unpublish reply carries the old live data; re-read the draft that holds the hidden mark.
					result = await getContent("photos", id);
				}
				if (!hidden && !needsLocationReview(dataOf(result.item))) result = await publishDraft("photos", id);
				onPhotoUpdated(result.item);
			} catch (cause) { failed.push({ id, reason: reasonOf(cause) }); }
		}
		retainFailures(failed);
		await recordOperation({ kind: hidden ? "photo-hide" : "photo-show", status: failed.length ? "partial" : "complete", targetIds: ids, failures: failed, metadata: { albumId: album.id } }).catch(() => undefined);
		const done = ids.length - failed.length;
		setMessage(failed.length ? `${done}点を処理・${failed.length}点が失敗` : hidden ? `${done}点を非公開にしました` : `${done}点を公開しました`);
		setBusy(false);
	};

	const trashPhotos = async (ids: string[]) => {
		if (!ids.length || operationLocked) return;
		if (!window.confirm(ids.length === 1 ? "この写真を削除しますか？（EmDashのゴミ箱から戻せます）" : `${ids.length}点の写真を削除しますか？（EmDashのゴミ箱から戻せます）`)) return;
		setBusy(true); setError(null); setFailures([]); setMessage("削除しています…");
		const failed: Failure[] = [];
		for (const id of ids) {
			try {
				const photo = allPhotos.find((item) => item.id === id);
				const cover = mediaUrl(dataOf(album).cover_image);
				if (photo && cover && cover === mediaUrl(dataOf(photo).image)) {
					throw new Error("カバー写真は、別の写真をカバーにしてから削除してください。");
				}
				await trashContent("photos", id);
				onPhotoRemoved(id);
			} catch (cause) { failed.push({ id, reason: reasonOf(cause) }); }
		}
		setChecked(new Set(failed.map((failure) => failure.id)));
		setFailures(failed);
		await recordOperation({ kind: "photo-trash", status: failed.length ? "partial" : "complete", targetIds: ids, failures: failed, metadata: { albumId: album.id } }).catch(() => undefined);
		setMessage(failed.length ? `${ids.length - failed.length}点を削除・${failed.length}点が失敗` : `${ids.length}点を削除しました`);
		setBusy(false);
		onRefresh();
	};

	const toggleChecked = (photoId: string) => {
		if (!canChangeOrganizerContext()) return;
		const next = new Set(checked);
		next.has(photoId) ? next.delete(photoId) : next.add(photoId);
		setChecked(next);
		// Checking photos selects them; the edit panel follows a single selection.
		if (next.size === 1) setSelectedId([...next][0]);
		else if (next.size === 0) { setSelectedId(null); setMobilePane("photos"); }
		else if (!selectedId || !next.has(selectedId)) setSelectedId([...next][0]);
	};

	/** Read EXIF, order the selection by capture time and start uploading. */
	const enqueueFiles = async (requestedFiles: File[]) => {
		if (!requestedFiles.length || operationLocked) return;
		setBusy(true); setError(null); setMessage(`${requestedFiles.length}点の撮影情報を読み取っています…`);
		const metadata = uploadMetadata.current;
		for (const file of requestedFiles) {
			if (!ACCEPTED_IMAGE_TYPES.has(file.type) || metadata.has(file)) continue;
			try {
				// Camera metadata sits at the head of a JPEG; other formats are read whole.
				const head = file.type === "image/jpeg" ? file.slice(0, 1024 * 1024) : file;
				metadata.set(file, readPhotoMetadata(new Uint8Array(await head.arrayBuffer())));
			} catch {
				metadata.set(file, { hasLocation: false, readable: false });
			}
		}
		const time = (file: File) => {
			const value = metadata.get(file)?.capturedAt;
			return value ? Date.parse(value) : Number.POSITIVE_INFINITY;
		};
		const ordered = requestedFiles
			.map((file, index) => ({ file, index }))
			.toSorted((left, right) => time(left.file) - time(right.file) || left.index - right.index)
			.map(({ file }) => file);
		let existing: ContentItem[];
		try { existing = await albumPhotosForOperation(album.id); }
		catch (cause) { setError(new Error(reasonOf(cause))); setMessage(""); setBusy(false); return; }
		const identities = existingUploadIdentities(existing);
		knownHashes.current = identities.hashes;
		const queue = skipDuplicateUploads(createUploadQueue<File, PhotoMediaItem>(ordered, {
			batchId: String(Date.now()),
			startPosition: Math.max(albumCount?.maxPosition ?? 0, ...existing.map((photo) => Number(dataOf(photo).position) || 0)),
			acceptedTypes: ACCEPTED_IMAGE_TYPES,
			maxBytes: MAX_UPLOAD_BYTES,
			maxFiles: MAX_UPLOAD_FILES,
		}), identities.keys);
		setUploadQueue(queue);
		setBusy(false);
		await executeUploadQueue(queue);
	};

	const pendingTaken = useRef(false);
	useEffect(() => {
		if (pendingTaken.current || !pendingFiles?.length || operationLocked) return;
		pendingTaken.current = true;
		onPendingFilesTaken?.();
		void enqueueFiles(pendingFiles);
	}, [pendingFiles, operationLocked]);

	/** Widen the album's capture period to cover newly added photos. */
	const extendAlbumPeriod = async (times: string[]) => {
		if (!times.length) return;
		const sorted = times.toSorted((left, right) => Date.parse(left) - Date.parse(right));
		const current = await getContent("albums", album.id);
		const from = textValue(dataOf(current.item).captured_from);
		const to = textValue(dataOf(current.item).captured_to);
		const patch: Record<string, string> = {};
		if (!from || Date.parse(sorted[0]) < Date.parse(from)) patch.captured_from = sorted[0];
		if (!to || Date.parse(sorted.at(-1)!) > Date.parse(to)) patch.captured_to = sorted.at(-1)!;
		if (!Object.keys(patch).length) return;
		const result = await updateDraft("albums", album.id, current._rev, patch);
		onAlbumUpdated(result.item);
	};

	const executeUploadQueue = async (initial: UploadQueueItem<File, PhotoMediaItem>[]) => {
		setBusy(true); setUploading(true); setError(null); setFailures([]);
		// Keep a phone's screen on: a locked screen suspends the page and stops the uploads.
		let wakeLock: { release: () => Promise<void> } | null = null;
		try { wakeLock = await (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null; }
		catch { /* not supported or not allowed */ }
		let working = initial;
		const updateItem = (id: string, patch: Partial<Omit<UploadQueueItem<File, PhotoMediaItem>, "id" | "file" | "position">>) => {
			working = updateUploadQueueItem(working, id, patch);
			setUploadQueue(working);
		};
		const created: string[] = [];
		const capturedTimes: string[] = [];
		let locationErased = 0;
		for (const queued of initial) {
			let item = working.find((candidate) => candidate.id === queued.id) ?? queued;
			if (item.stage === "queued") {
				updateItem(item.id, { stage: "uploading-media", error: undefined });
				setMessage(`${item.file.name} をアップロード中…`);
				try {
					const media = await uploadPhotoMedia(item.file);
					updateItem(item.id, { stage: "media-ready", media, error: undefined });
					item = { ...item, stage: "media-ready", media, error: undefined };
				} catch (cause) {
					updateItem(item.id, { stage: "failed-media", error: reasonOf(cause) });
					continue;
				}
			}
			if (item.stage !== "media-ready" || !item.media) continue;
			// EmDash reuses the stored file for identical content; such a photo is already in the album.
			if (item.media.contentHash && knownHashes.current.has(item.media.contentHash)) {
				updateItem(item.id, { stage: "skipped-duplicate", error: undefined });
				continue;
			}
			updateItem(item.id, { stage: "creating-photo", error: undefined });
			setMessage(`${item.file.name} をアルバムに登録中…`);
			try {
				const metadata = uploadMetadata.current.get(item.file);
				const result = await createPhotoFromMedia(item.media, album.id, item.position, metadata, uploadFileKey(item.file));
				if (item.media.contentHash) knownHashes.current.add(item.media.contentHash);
				if (metadata?.capturedAt) capturedTimes.push(metadata.capturedAt);
				// Android hands browsers photos whose GPS fields are kept but zeroed.
				if (metadata?.hasLocation && metadata.latitude === undefined) locationErased += 1;
				onPhotoAdded(result.item);
				touch(result.item.id);
				created.push(result.item.id);
				updateItem(item.id, { stage: "photo-created", photoId: result.item.id, error: undefined });
			} catch (cause) {
				updateItem(item.id, { stage: "failed-photo", media: item.media, error: reasonOf(cause) });
			}
		}
		await wakeLock?.release().catch(() => undefined);
		setUploading(false);
		const skipped = working.filter((item) => item.stage === "skipped-duplicate").length;
		const failed = working
			.filter((item) => item.stage.startsWith("failed-"))
			.map((item) => ({ id: item.file.name, reason: item.error ?? "不明なエラー" }));
		setFailures(failed);
		try { await extendAlbumPeriod(capturedTimes); }
		catch (cause) { failed.push({ id: album.id, reason: `撮影期間を更新できませんでした: ${reasonOf(cause)}` }); setFailures([...failed]); }
		await recordOperation({
			kind: "photo-upload",
			status: failed.length ? "partial" : "complete",
			targetIds: created,
			failures: failed,
			metadata: { albumId: album.id, requested: initial.length },
		}).catch(() => undefined);
		setMessage(failed.length
			? `${created.length}点を追加・${failed.length}点が失敗（この画面で失敗分だけ再試行できます）`
			: `${created.length}点を追加しました${skipped ? `（アルバムにある${skipped}点は省略）` : ""}。「${album.status === "published" ? "変更を公開" : "アルバムを公開"}」で公開されます。`);
		setLocationErased(locationErased);
		setBusy(false);
		if (created.length) onRefresh();
	};

	const orderedVisibleIds = visible.map((photo) => photo.id);
	// Phones: long-press a photo, then drag it to its new place (desktop keeps drag and drop).
	const tileReorder = usePointerReorder({
		enabled: canReorder && !operationLocked && !selecting,
		touchOnly: true,
		onMove: (from, to) => { const next = [...albumPhotos]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); void persistOrder(next); },
	});
	const uploadSettled = uploadQueue.filter((item) => isUploadQueueSettled(item.stage)).length;
	const hasRetryableUpload = uploadQueue.some((item) => isUploadQueueRetryable(item.stage));

	const photoTotal = albumCount?.total ?? albumPhotos.length;
	const albumEmpty = albumReady && photoTotal === 0 && !search && !filter;
	const pendingCount = Math.max(albumCount?.pending ?? 0, pendingIds.size) + (albumDraftDirty || hasPendingChanges(album) ? 1 : 0);
	const addPhotosInput = <input type="file" accept={ACCEPTED_IMAGE_INPUT} multiple hidden disabled={operationLocked} onChange={(event) => {
		const requestedFiles = [...(event.target.files ?? [])];
		event.currentTarget.value = "";
		void enqueueFiles(requestedFiles);
	}} />;
	const carriesFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

	const coverUrl = mediaUrl(dataOf(album).cover_image);
	const periodFrom = dateTimeLocalInputValue(dataOf(album).captured_from).slice(0, 10).replaceAll("-", "/");
	const periodTo = dateTimeLocalInputValue(dataOf(album).captured_to).slice(0, 10).replaceAll("-", "/");
	const period = periodFrom ? (periodTo && periodTo !== periodFrom ? `${periodFrom}〜${periodTo.slice(0, 4) === periodFrom.slice(0, 4) ? periodTo.slice(5) : periodTo}` : periodFrom) : "";
	const albumState = album.status !== "published" ? "下書き" : workspacePending ? "未公開の変更あり" : "公開中";
	const panelOpen = checkedPhotos.length > 1 || Boolean(inspectorPhoto && dataOf(inspectorPhoto).album === album.id);
	const closePanel = () => { if (!canChangeOrganizerContext()) return; setChecked(new Set()); setSelectedId(null); setMobilePane("photos"); };
	const sortByCaptureTime = async () => {
		setBusy(true);
		try {
			await persistOrder((await albumPhotosForOperation(album.id)).sort((left, right) => compareCapturedAt(
				dataOf(left).captured_at,
				dataOf(right).captured_at,
				Number(dataOf(left).position) || 0,
				Number(dataOf(right).position) || 0,
				left.id,
				right.id,
			)));
		} catch (cause) { setError(cause); } finally { setBusy(false); }
	};
	const saveSort = async () => {
		setBusy(true); setError(null);
		try {
			const current = await getContent("albums", album.id);
			// A sort change alone goes live at once; an album with other unpublished edits keeps it as a draft.
			const liveOnly = current.item.status === "published" && !hasPendingChanges(current.item);
			let result = await updateDraft("albums", album.id, current._rev, { sort_method: sortDraft.method, sort_direction: sortDraft.direction });
			if (liveOnly) result = await publishDraft("albums", album.id);
			onAlbumUpdated(result.item);
			setSortOpen(false);
			setMessage(liveOnly ? "並び順を変更しました" : "並び順を下書きに保存しました。「公開」でサイトに反映されます");
			onRefresh();
		} catch (cause) { setError(new Error(reasonOf(cause))); } finally { setBusy(false); }
	};
	const makeCover = async (photo: ContentItem) => {
		setBusy(true); setError(null);
		try {
			if (!album._rev) throw new Error("アルバムの編集情報を再読込してください。");
			const result = await updateDraft("albums", album.id, album._rev, { cover_image: dataOf(photo).image });
			onAlbumUpdated(result.item); setMessage("表紙を変更しました（下書き）");
		} catch (cause) { setError(new Error(reasonOf(cause))); } finally { setBusy(false); }
	};

	return <section data-organizer-ready={albumReady ? "true" : "false"} className={`photo-tools-workspace ${panelOpen ? "has-panel" : ""} ${mobilePane === "info" && panelOpen ? "is-sheet-open" : ""}`} data-photo-tools-busy={busy ? "true" : undefined}
		onDragEnter={(event) => { if (carriesFiles(event)) { event.preventDefault(); setDragDepth((depth) => depth + 1); } }}
		onDragOver={(event) => { if (carriesFiles(event)) event.preventDefault(); }}
		onDragLeave={(event) => { if (carriesFiles(event)) setDragDepth((depth) => Math.max(0, depth - 1)); }}
		onDrop={(event) => {
			if (!carriesFiles(event)) return;
			event.preventDefault(); setDragDepth(0);
			void enqueueFiles([...event.dataTransfer.files]);
		}}>
		{dragDepth > 0 && !operationLocked && <div className="photo-tools-drop-overlay" aria-hidden="true"><Icon name="upload" size={28} /><strong>ここで離すと「{labelOf(album)}」に追加します</strong></div>}

		<button type="button" className="photo-tools-back" onClick={() => { if (canChangeOrganizerContext()) onBack(); }}><Icon name="back" />アルバム一覧</button>
		<header className="photo-tools-workspace__header">
			<div className="photo-tools-workspace__title">
				<h1>{labelOf(album)}</h1>
				<p>
					<span className={`photo-tools-state photo-tools-state--${album.status !== "published" ? "muted" : workspacePending ? "warn" : "ok"}`}>{albumState}</span>
					<span>{!albumReady ? "読み込み中" : `${photoTotal}点`}</span>
					{period && <span>{period}</span>}
					{pendingCount > 0 && album.status === "published" && <span>変更 {pendingCount}件</span>}
				</p>
			</div>
			<div className="photo-tools-actions">
				<label className={`photo-tools-button photo-tools-upload ${photoTotal === 0 || !workspacePending ? "photo-tools-button--primary" : ""}`} aria-disabled={operationLocked}><Icon name="plus" />写真を追加{addPhotosInput}</label>
				{photoTotal > 0 && (workspacePending || album.status !== "published") && <button type="button" className="photo-tools-button photo-tools-button--primary" disabled={operationLocked || !albumDraft.title.trim()} onClick={publishWorkspace}>{busy ? "処理中…" : album.status === "published" ? "変更を公開" : "アルバムを公開"}</button>}
				<Menu label="そのほかの操作">
					<button type="button" role="menuitem" onClick={() => setSettingsOpen(true)}>アルバム名と説明を編集</button>
					<button type="button" role="menuitem" onClick={() => { setSortDraft(albumSort); setSortOpen(true); }}>並び順（{PHOTO_SORT_LABELS[albumSort.method]}{albumSort.direction === "desc" ? "・降順" : ""}）</button>
					<button type="button" role="menuitem" disabled={operationLocked || photoTotal < 2} onClick={() => void sortByCaptureTime()}>撮影日時の順に並べ直す</button>
					{undoOrder && <button type="button" role="menuitem" disabled={operationLocked} onClick={() => restore(undoOrder, "order")}>並び順を元に戻す</button>}
					{undoMove && <button type="button" role="menuitem" disabled={operationLocked} onClick={() => restore(undoMove, "move")}>移動を元に戻す</button>}
					<hr />
					{live && album.status === "published" && <a role="menuitem" href={live} target="_blank" rel="noreferrer">公開ページを開く</a>}
					<a role="menuitem" href={albumEditHref(album.id)} onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>詳細編集（SEOなど）</a>
				</Menu>
			</div>
		</header>

		{(settingsOpen || albumDraftDirty) && <section className="photo-tools-album-settings" data-photo-tools-dirty={albumDraftDirty ? "true" : undefined} aria-label="アルバム名と説明">
			<label>アルバム名<input value={albumDraft.title} disabled={busy} onChange={(event) => setAlbumDraft({ ...albumDraft, title: event.target.value })} /></label>
			<label>説明<textarea value={albumDraft.description} disabled={busy} rows={2} onChange={(event) => setAlbumDraft({ ...albumDraft, description: event.target.value })} /></label>
			<div className="photo-tools-actions">
				<button type="button" className="photo-tools-button photo-tools-button--primary" disabled={busy || !albumDraftDirty || !albumDraft.title.trim()} onClick={async () => { await saveAlbumDraft(); setSettingsOpen(false); }}>下書きに保存</button>
				<button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={busy} onClick={() => { setAlbumDraft({ title: textValue(dataOf(album).title), description: textValue(dataOf(album).description) }); setSettingsOpen(false); }}>閉じる</button>
			</div>
		</section>}

		{sortOpen && <section className="photo-tools-album-settings photo-tools-sort" aria-label="並び順">
			<label>並べ方<select value={sortDraft.method} disabled={busy} onChange={(event) => setSortDraft({ ...sortDraft, method: event.target.value })}>{Object.entries(PHOTO_SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
			<label>向き<select value={sortDraft.direction} disabled={busy} onChange={(event) => setSortDraft({ ...sortDraft, direction: event.target.value })}><option value="asc">昇順（古い順・A→Z）</option><option value="desc">降順（新しい順・Z→A）</option></select></label>
			<div className="photo-tools-actions">
				<button type="button" className="photo-tools-button photo-tools-button--primary" disabled={busy || (sortDraft.method === albumSort.method && sortDraft.direction === albumSort.direction)} onClick={() => void saveSort()}>保存</button>
				<button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={busy} onClick={() => setSortOpen(false)}>閉じる</button>
			</div>
			<p className="photo-tools-note">公開サイトのアルバムもこの順に並びます。「手動」にすると、写真をドラッグして並べ替えられます（スマホは長押ししてから動かします）。</p>
		</section>}

		{uploadQueue.length > 0 && <section className="photo-tools-upload-queue" aria-label="写真追加の進捗" aria-live="polite">
			<header>
				<strong>{uploading ? "写真を追加しています" : "写真の追加"}</strong>
				<span>{uploadSettled} / {uploadQueue.length}点</span>
				{hasRetryableUpload && <button type="button" className="photo-tools-button photo-tools-button--small" disabled={busy} onClick={() => void executeUploadQueue(retryFailedUploadQueue(uploadQueue))}>失敗分を再試行</button>}
				{!uploading && !hasRetryableUpload && <button type="button" className="photo-tools-button photo-tools-button--small photo-tools-button--ghost" onClick={() => setUploadQueue([])}>閉じる</button>}
			</header>
			<progress aria-label="写真追加の完了件数" max={uploadQueue.length} value={uploadSettled}>{uploadSettled}/{uploadQueue.length}</progress>
			<details open={hasRetryableUpload}>
				<summary>ファイルごとの状況</summary>
				<ul>{uploadQueue.map((item) => <li key={item.id} data-stage={item.stage}>
					<span title={item.file.name}>{item.file.name}</span>
					<strong>{UPLOAD_STAGE_LABELS[item.stage]}</strong>
					{item.error && <small>{item.error}</small>}
				</li>)}</ul>
			</details>
			<p className="photo-tools-note">{uploading ? "終わるまでこの画面を開いたままにしてください。" : ""}撮影日時の順に追加します。公開するまでサイトには出ません。途中で止まったら、同じ写真をまとめて選び直すと残りだけ追加されます。</p>
		</section>}

		{(message || photoDraftDirty) && <p className="photo-tools-status" role="status">{photoDraftDirty ? "写真情報に未保存の変更があります。保存すると、ほかの操作に戻れます。" : message}</p>}
		<ErrorBox error={error} />
		{locationErased > 0 && <div className="photo-tools-alert" role="status">
			<strong>{locationErased}点は、位置情報がスマートフォン側で消されていました。</strong>
			<p>Android は、ブラウザに渡す写真から位置情報を消します（位置の欄は残りますが中身が空です）。位置を残すには、パソコンから元の写真を追加してください。撮影日時は読み取れています。</p>
			<button type="button" className="photo-tools-button photo-tools-button--small photo-tools-button--ghost" onClick={() => setLocationErased(0)}>閉じる</button>
		</div>}
		{failures.length > 0 && <div className="photo-tools-alert photo-tools-alert--error"><strong>{failures.length}件を処理できませんでした。</strong><ul>{failures.map((failure) => <li key={`${failure.id}:${failure.reason}`}><code>{failure.id}</code>: {failure.reason}</li>)}</ul></div>}

		{albumEmpty
			? <label className="photo-tools-dropzone" aria-disabled={operationLocked}>
				<Icon name="upload" size={28} />
				<strong>写真を追加</strong>
				<span className="photo-tools-dropzone__mouse">ここに写真をドラッグするか、クリックして選んでください</span>
				<span className="photo-tools-dropzone__touch">タップして、写真ライブラリやカメラから選べます</span>
				<small>まとめて選べます（1回{MAX_UPLOAD_FILES}点まで）。撮影日時と位置情報は写真のEXIFから読み取ります。写真を追加すると、アルバムを公開できます。</small>
				{addPhotosInput}
			</label>
			: <div className="photo-tools-content">
				<section className="photo-tools-grid-area" aria-label="アルバムの写真">
					<div className="photo-tools-toolbar">
						<label className="photo-tools-search"><Icon name="search" /><input type="search" aria-label="写真を検索" placeholder="タイトル・キャプション・ファイル名で検索" value={search} disabled={busy || !albumReady} onChange={(event) => setSearch(event.target.value)} /></label>
						<select aria-label="絞り込み" value={filter} disabled={busy || !albumReady} onChange={(event) => setFilter(event.target.value as "" | ReviewFlag)}><option value="">すべての写真</option>{Object.entries(FLAG_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
						<select aria-label="並べ方" value={viewOrder} disabled={!albumReady} onChange={(event) => setViewOrder(event.target.value as ViewOrder)}>{Object.entries(VIEW_ORDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
						<button type="button" className="photo-tools-button photo-tools-button--ghost photo-tools-shape-toggle" aria-pressed={tileShape === "original"} onClick={() => setTileShape(tileShape === "original" ? "square" : "original")} title="サムネイルを元の縦横比で表示">{tileShape === "original" ? "元の縦横比" : "正方形"}</button>
						<span className="photo-tools-toolbar__count">{!albumReady ? "読み込み中…" : checked.size ? `${checked.size}点を選択中` : visible.length < resultTotal ? `${resultTotal}点中 ${visible.length}点を表示` : `${resultTotal}点`}</span>
						{(selecting || checked.size > 0) && (checked.size
							? <button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={busy} onClick={() => setChecked(new Set())}>選択を解除</button>
							: <button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={operationLocked || visible.length === 0} onClick={() => { if (canChangeOrganizerContext()) { setSelectedId(null); setChecked(new Set(visible.map((photo) => photo.id))); } }}>すべて選択</button>)}
						<button type="button" className={`photo-tools-button ${selecting ? "photo-tools-button--primary" : ""}`} aria-pressed={selecting} disabled={!albumReady} onClick={() => { if (selecting) { setSelecting(false); setChecked(new Set()); setSelectedId(null); setMobilePane("photos"); } else { setSelecting(true); } }}><Icon name="check" />{selecting ? "完了" : "選択"}</button>
					</div>
					{firstOffset > 0 && <button type="button" className="photo-tools-button photo-tools-more" disabled={operationLocked} onClick={onFirstPage}>先頭から表示</button>}
					{visible.length ? <div className={`photo-tools-grid ${selecting || checked.size > 0 ? "is-selecting" : ""} ${tileShape === "original" ? "is-original" : ""}`}>{visible.map((photo) => {
						const index = albumPhotos.findIndex((item) => item.id === photo.id);
						const flags = photoReviewFlags(dataOf(photo), { status: photo.status });
						const isCover = Boolean(coverUrl) && coverUrl === mediaUrl(dataOf(photo).image);
						const hidden = isHiddenPhoto(dataOf(photo));
						const state = hidden ? "非公開" : photo.status !== "published" ? "下書き" : hasPendingChanges(photo) ? "変更あり" : "";
						const needsAttention = flags.includes("location-unreviewed");
						return <article key={photo.id} className={`photo-tools-tile ${inspectorPhoto?.id === photo.id && checkedPhotos.length < 2 ? "is-active" : ""} ${checked.has(photo.id) ? "is-checked" : ""} ${hidden ? "is-hidden" : ""} ${dragId === photo.id || tileReorder.dragging === index ? "is-dragging" : ""} ${tileReorder.dragging !== null && tileReorder.over === index && tileReorder.dragging !== index ? "is-drop-target" : ""}`} data-reorder-index={index} onPointerDown={(event) => tileReorder.start(event, index)} draggable={!operationLocked && canReorder} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragId(photo.id); }} onDragEnd={() => setDragId(null)} onDragOver={(event) => { if (dragId) event.preventDefault(); }} onDrop={(event) => {
							if (!dragId) return;
							event.preventDefault(); event.stopPropagation();
							if (dragId === photo.id || !canReorder) { setDragId(null); return; }
							const next = [...albumPhotos]; const from = next.findIndex((item) => item.id === dragId); const [moved] = next.splice(from, 1); next.splice(index, 0, moved); setDragId(null); void persistOrder(next);
						}} onKeyDown={(event) => {
							if (!canReorder || !event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
							event.preventDefault(); moveAt(index, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
						}}>
							<button className="photo-tools-tile__open" type="button" disabled={busy} aria-label={selecting ? `${labelOf(photo)}を選択` : `${labelOf(photo)}を編集`} onClick={() => {
								// In selection mode a tap ticks the photo, as in a phone's photo app.
								if (selecting) { toggleChecked(photo.id); return; }
								if (!canChangeOrganizerContext()) return; setChecked(new Set()); setSelectedId(photo.id); setMobilePane("info");
							}}>
								<span className="photo-tools-tile__media"><Preview value={dataOf(photo).image} /></span>
								{photoTitleOf(photo)
									? <span className="photo-tools-tile__caption">{photoTitleOf(photo)}</span>
									: <span className="photo-tools-tile__caption is-muted">{capturedLabelOf(photo) || "タイトル未設定"}</span>}
							</button>
							<label className="photo-tools-tile__check" title="選択"><input type="checkbox" aria-label={`${labelOf(photo)}を選択`} checked={checked.has(photo.id)} disabled={busy || !albumReady} onChange={() => toggleChecked(photo.id)} /></label>
							<span className="photo-tools-tile__flags">
								{isCover && <span className="photo-tools-flag photo-tools-flag--cover">表紙</span>}
								{state && <span className={`photo-tools-flag ${hidden ? "photo-tools-flag--muted" : "photo-tools-flag--warn"}`}>{state}</span>}
								{needsAttention && <span className="photo-tools-flag photo-tools-flag--danger">要確認</span>}
							</span>
						</article>;
					})}</div> : <p className="photo-tools-empty">{!albumReady ? "写真を読み込んでいます…" : "この条件に合う写真はありません。"}</p>}
					{nextOffset !== null && <button ref={moreButton} type="button" className="photo-tools-button photo-tools-more" disabled={operationLocked} onClick={onLoadMore}>続きを読み込む</button>}
					<p className="photo-tools-hint">{canReorder ? "ドラッグで並べ替えられます（スマホは長押ししてから動かします。キーボードは Alt＋矢印）。" : albumSort.method !== "position" ? "手で並べ替えるには、「…」→「並び順」で「手動」を選びます。" : "並べ替えは「アルバムの順」で、検索や絞り込みをしていないときにできます。"}写真を押すと情報を編集できます。「選択」でまとめて操作できます。</p>
				</section>
				{panelOpen && (checkedPhotos.length > 1
					? <BulkInspector selected={checkedPhotos} albums={albums} busy={busy} onApply={applyBulk} onMove={moveSelected} onPublish={publishMany} onHide={setHidden} onTrash={trashPhotos} onClear={() => { setChecked(new Set()); setMobilePane("photos"); }} />
					: inspectorPhoto && inspectorReady
						? <PhotoInspector photo={inspectorPhoto} albums={albums} busy={busy} onSave={savePhoto} onPublish={publishMany} onHide={setHidden} onTrash={trashPhotos} onDirtyChange={setPhotoDraftDirty} previousId={adjacentPhotoId(orderedVisibleIds, inspectorPhoto.id, -1)} nextId={adjacentPhotoId(orderedVisibleIds, inspectorPhoto.id, 1)} onNavigate={(photoId) => { setChecked(new Set()); setSelectedId(photoId); setMobilePane("info"); }}
							onClose={closePanel}
							onMove={(delta) => moveAt(albumPhotos.findIndex((item) => item.id === inspectorPhoto.id), delta)}
							canMoveBack={albumPhotos.findIndex((item) => item.id === inspectorPhoto.id) > 0}
							canMoveForward={albumPhotos.findIndex((item) => item.id === inspectorPhoto.id) < albumPhotos.length - 1}
							isCover={Boolean(coverUrl) && coverUrl === mediaUrl(dataOf(inspectorPhoto).image)}
							onMakeCover={() => void makeCover(inspectorPhoto)} />
						: <aside className="photo-tools-inspector photo-tools-inspector--loading">{photoHydration?.identity === inspectorIdentity && photoHydration.status === "error"
							? <><ErrorBox error={photoHydration.error} /><button type="button" className="photo-tools-button" onClick={() => setPhotoHydrationRetry((value) => value + 1)}>再試行</button></>
							: <p className="photo-tools-note" role="status">写真の情報を読み込んでいます…</p>}</aside>)}
			</div>}

		{!albumEmpty && checked.size > 0 && mobilePane !== "info" && <div className="photo-tools-selection-bar" role="region" aria-label="選択中の写真">
			<strong>{checked.size}点を選択中</strong>
			<button type="button" className="photo-tools-button photo-tools-button--primary" onClick={() => setMobilePane("info")}>操作</button>
			<button type="button" className="photo-tools-button photo-tools-button--ghost" onClick={() => setChecked(new Set())}>解除</button>
		</div>}
		{!albumEmpty && checked.size === 0 && !selecting && mobilePane !== "info" && <div className="photo-tools-mobile-add">
			<label className="photo-tools-button photo-tools-button--primary photo-tools-upload" aria-disabled={operationLocked} aria-label="写真を追加"><Icon name="plus" size={22} /><span>追加</span>{addPhotosInput}</label>
		</div>}
	</section>;
}

const ADMIN_GROUP = "写真";
const SETUP_DISMISSED_KEY = "yohaku-photo-tools:admin-setup-dismissed";
const READONLY_PHOTO_FIELDS = ["position", "source_system", "source_id", "source_url", "original_sha256", "source_metadata", "altitude"];
type SchemaField = { slug: string; widget?: string | null; validation?: unknown };
type SchemaCollection = { slug: string; label?: string; group?: string | null; hidden?: boolean; fields?: SchemaField[] };
type SetupStep = "group" | "hidePhotos" | "hideUrlMappings" | "widgets";
const SETUP_ORDER: SetupStep[] = ["group", "hidePhotos", "hideUrlMappings", "widgets"];
/** Step descriptions, using the collection names this site's sidebar shows. */
function setupStepLabel(step: SetupStep, schema: { albums: SchemaCollection; photos: SchemaCollection; urls: SchemaCollection | null }) {
	const albums = schema.albums.label || "アルバム";
	const photos = schema.photos.label || "公開写真";
	switch (step) {
		case "group": return `サイドバーの「${albums}」「${photos}」と「写真を整理」を、ひとつの「写真」フォルダーにまとめる`;
		case "hidePhotos": return `「${photos}」をサイドバーとダッシュボードの追加ボタンから外す（写真の作業は「写真を整理」で行う。一覧は直接URLで開ける）`;
		case "hideUrlMappings": return `「${schema.urls?.label || "URL Mappings"}」（旧サイトからの転送表）をサイドバーから外す`;
		case "widgets": return "標準の写真編集画面で、アルバム欄を選択式にし、並び順・取り込み元などの内部用の欄を読み取り専用にする";
	}
}

async function readCollectionSchema(slug: string): Promise<SchemaCollection> {
	const data = await parseApiResponse<{ item?: SchemaCollection } & SchemaCollection>(
		await apiFetch(`/_emdash/api/schema/collections/${slug}?includeFields=true`),
		"管理画面の設定を確認できませんでした。",
	);
	return data.item ?? data;
}

function setupDone(step: SetupStep, schema: { albums: SchemaCollection; photos: SchemaCollection; urls: SchemaCollection | null }) {
	const field = (slug: string) => schema.photos.fields?.find((candidate) => candidate.slug === slug);
	switch (step) {
		case "group": return schema.albums.group === ADMIN_GROUP && schema.photos.group === ADMIN_GROUP;
		case "hidePhotos": return Boolean(schema.photos.hidden);
		case "hideUrlMappings": return !schema.urls || Boolean(schema.urls.hidden);
		case "widgets": return field("album")?.widget === "yohaku-photo-tools:album-picker"
			&& READONLY_PHOTO_FIELDS.every((slug) => !field(slug) || field(slug)?.widget === "yohaku-photo-tools:readonly");
	}
}

/**
 * One-time tidy-up of EmDash's standard screens for photo work. It changes the
 * site's admin settings, so it only runs when the owner presses the button.
 */
function AdminSetupCard() {
	const [schema, setSchema] = useState<{ albums: SchemaCollection; photos: SchemaCollection; urls: SchemaCollection | null } | null>(null);
	const [chosen, setChosen] = useState<Set<SetupStep>>(new Set(["group", "hidePhotos", "widgets"]));
	const [state, setState] = useState<"idle" | "applying" | "done">("idle");
	const [error, setError] = useState<unknown>(null);
	const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(SETUP_DISMISSED_KEY) === "1"; } catch { return false; } });
	const load = () => Promise.all([readCollectionSchema("albums"), readCollectionSchema("photos"), readCollectionSchema("url_mappings").catch(() => null)])
		.then(([albums, photos, urls]) => setSchema({ albums, photos, urls }));
	useEffect(() => { if (!dismissed) load().catch(() => setSchema(null)); }, [dismissed]);
	if (dismissed || !schema) return null;
	const pending = SETUP_ORDER.filter((step) => !setupDone(step, schema));
	// The URL Mappings step is optional: it alone does not bring the card back.
	if (!pending.some((step) => step !== "hideUrlMappings") && state !== "done") return null;
	const put = async (path: string, body: unknown) => parseApiResponse(await apiFetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), "設定を変更できませんでした。管理者権限を確認してください。");
	const apply = async () => {
		setState("applying"); setError(null);
		try {
			const steps = pending.filter((step) => chosen.has(step));
			if (steps.includes("group")) await put("/_emdash/api/schema/collections/albums", { group: ADMIN_GROUP });
			if (steps.includes("group") || steps.includes("hidePhotos")) {
				await put("/_emdash/api/schema/collections/photos", { ...(steps.includes("group") ? { group: ADMIN_GROUP } : {}), ...(steps.includes("hidePhotos") ? { hidden: true } : {}) });
			}
			if (steps.includes("hideUrlMappings") && schema.urls) await put("/_emdash/api/schema/collections/url_mappings", { hidden: true });
			if (steps.includes("widgets")) {
				for (const field of schema.photos.fields ?? []) {
					const widget = field.slug === "album" ? "yohaku-photo-tools:album-picker" : READONLY_PHOTO_FIELDS.includes(field.slug) ? "yohaku-photo-tools:readonly" : null;
					if (!widget || field.widget === widget) continue;
					await put(`/_emdash/api/schema/collections/photos/fields/${field.slug}`, { widget, validation: field.validation ?? null });
				}
			}
			await load();
			setState("done");
		} catch (cause) { setError(cause); setState("idle"); }
	};
	if (state === "done") return <section className="photo-tools-setup" role="status">
		<strong>管理画面の設定を変更しました。</strong>
		<p>サイドバーは、管理画面を再読み込みすると変わります。</p>
		<div className="photo-tools-actions"><button type="button" className="photo-tools-button photo-tools-button--primary" onClick={() => window.location.reload()}>再読み込み</button></div>
	</section>;
	return <section className="photo-tools-setup" aria-label="管理画面の整理">
		<strong>EmDash の標準画面を、写真の作業向けに整えられます</strong>
		<p>サイトの管理画面の設定を変更します。公開サイトの表示は変わりません。あとから「コンテンツタイプ」で元に戻せます。</p>
		<ul>{pending.map((step) => <li key={step}><label className="photo-tools-check-row"><input type="checkbox" checked={chosen.has(step)} disabled={state === "applying"} onChange={() => setChosen((current) => { const next = new Set(current); next.has(step) ? next.delete(step) : next.add(step); return next; })} />{setupStepLabel(step, schema)}</label></li>)}</ul>
		<ErrorBox error={error} />
		<div className="photo-tools-actions">
			<button type="button" className="photo-tools-button photo-tools-button--primary" disabled={state === "applying" || !pending.some((step) => chosen.has(step))} onClick={() => void apply()}>{state === "applying" ? "設定しています…" : "選んだ内容で設定する"}</button>
			<button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={state === "applying"} onClick={() => { try { localStorage.setItem(SETUP_DISMISSED_KEY, "1"); } catch { /* hide for this visit */ } setDismissed(true); }}>今はしない</button>
		</div>
	</section>;
}

type OrganizerTab = "albums" | "library" | "search";
const ORGANIZER_TABS: Array<{ id: OrganizerTab; label: string; icon: IconName }> = [
	{ id: "albums", label: "アルバム", icon: "albums" },
	{ id: "library", label: "ライブラリ", icon: "library" },
	{ id: "search", label: "検索", icon: "search" },
];
const RECENT_ALBUMS_KEY = "yohaku-photo-tools:recent-albums";
const WEEKDAYS = "日月火水木金土";

function readTab(): OrganizerTab {
	const value = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("tab");
	return value === "library" || value === "search" ? value : "albums";
}
function readRecentAlbums(): string[] {
	try { const ids = JSON.parse(localStorage.getItem(RECENT_ALBUMS_KEY) ?? "[]"); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; }
	catch { return []; }
}
function rememberRecentAlbum(id: string) {
	try { localStorage.setItem(RECENT_ALBUMS_KEY, JSON.stringify([id, ...readRecentAlbums().filter((other) => other !== id)].slice(0, 8))); }
	catch { /* only a convenience */ }
}
/** "2026/03/13（金）" for a photo's capture day. */
function captureDayLabel(item: ContentItem): string {
	const value = dateTimeLocalInputValue(dataOf(item).captured_at);
	if (!value) return "撮影日なし";
	const day = new Date(`${value.slice(0, 10)}T00:00:00`);
	return `${value.slice(0, 10).replaceAll("-", "/")}（${WEEKDAYS[day.getDay()]}）`;
}

/** アルバム・ライブラリ・検索 (as in the app): at the bottom of a phone screen, under the title on a computer. */
function OrganizerTabs({ tab, onChange }: { tab: OrganizerTab; onChange: (tab: OrganizerTab) => void }) {
	return <nav className="photo-tools-tabs" aria-label="写真を整理の表示">
		{ORGANIZER_TABS.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>
			<Icon name={item.icon} size={20} /><span>{item.label}</span>
		</button>)}
	</nav>;
}

function PhotoGridTile({ photo, onOpen }: { photo: ContentItem; onOpen: () => void }) {
	const hidden = isHiddenPhoto(dataOf(photo));
	return <button type="button" className={`photo-tools-library__tile ${hidden ? "is-hidden" : ""}`} onClick={onOpen} aria-label={`${photoTitleOf(photo) || capturedLabelOf(photo) || "写真"}を開く`}>
		<Preview value={dataOf(photo).image} size={320} />
		{hidden && <span className="photo-tools-flag photo-tools-flag--muted">非公開</span>}
	</button>;
}

/** Every photo, newest capture first, by day (SmugMug's Library). */
function LibraryView({ onOpen }: { onOpen: (albumId: string, photoId: string) => void }) {
	const [items, setItems] = useState<ContentItem[]>([]);
	const [cursor, setCursor] = useState<string | null | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const sentinel = useRef<HTMLDivElement>(null);
	const loadingRef = useRef(false);
	const load = async () => {
		if (loadingRef.current || cursor === null) return;
		loadingRef.current = true; setLoading(true);
		try {
			const page = await contentPage("photos", { limit: 100, orderBy: "captured_at", order: "desc", cursor: cursor ?? undefined });
			setItems((current) => mergeEditableItems(current, page.items));
			setCursor(page.nextCursor ?? null);
		} catch (cause) { setError(cause); } finally { loadingRef.current = false; setLoading(false); }
	};
	useEffect(() => { void load(); }, []);
	useEffect(() => {
		const target = sentinel.current;
		if (!target || cursor === null || cursor === undefined) return;
		const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void load(); }, { rootMargin: "800px 0px" });
		observer.observe(target);
		return () => observer.disconnect();
	}, [cursor, items.length]);
	const days = useMemo(() => {
		const groups: Array<{ label: string; photos: ContentItem[] }> = [];
		for (const photo of items) {
			const label = captureDayLabel(photo);
			if (groups.at(-1)?.label === label) groups.at(-1)!.photos.push(photo);
			else groups.push({ label, photos: [photo] });
		}
		return groups;
	}, [items]);
	return <section className="photo-tools-library" aria-label="ライブラリ">
		<ErrorBox error={error} />
		{days.map((day) => <section key={day.label} className="photo-tools-library__day">
			<h2>{day.label}</h2>
			<div className="photo-tools-library__grid">{day.photos.map((photo) => <PhotoGridTile key={photo.id} photo={photo} onOpen={() => onOpen(textValue(dataOf(photo).album), photo.id)} />)}</div>
		</section>)}
		<div ref={sentinel} />
		{loading && <p className="photo-tools-note" role="status">写真を読み込んでいます…</p>}
		{!loading && cursor === null && items.length === 0 && <p className="photo-tools-empty">写真がありません。</p>}
	</section>;
}

function AlbumBanner({ album, onOpen }: { album: ContentItem; onOpen: () => void }) {
	return <button type="button" className="photo-tools-banner" onClick={onOpen}>
		{dataOf(album).cover_image ? <Preview value={dataOf(album).cover_image} size={768} /> : <span className="photo-tools-thumb photo-tools-thumb--empty" />}
		<span className="photo-tools-banner__title"><Icon name="albums" size={18} />{labelOf(album)}</span>
	</button>;
}

/** Albums by name and photos by title or caption; recently opened albums when empty (as in the app). */
function SearchView({ albums, onOpenAlbum, onOpenPhoto }: { albums: ContentItem[]; onOpenAlbum: (id: string) => void; onOpenPhoto: (albumId: string, photoId: string) => void }) {
	const [query, setQuery] = useState("");
	const [photos, setPhotos] = useState<ContentItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [recent, setRecent] = useState(readRecentAlbums);
	const term = query.trim();
	useEffect(() => {
		if (!term) { setPhotos([]); return; }
		let active = true;
		const timer = window.setTimeout(() => {
			setLoading(true); setError(null);
			contentPage("photos", { search: term, limit: 60 })
				.then((page) => { if (active) setPhotos(page.items); })
				.catch((cause) => { if (active) setError(cause); })
				.finally(() => { if (active) setLoading(false); });
		}, 300);
		return () => { active = false; window.clearTimeout(timer); };
	}, [term]);
	const needle = term.toLocaleLowerCase("ja");
	const albumMatches = term ? albums.filter((album) => labelOf(album).toLocaleLowerCase("ja").includes(needle)) : [];
	const recentAlbums = recent.map((id) => albums.find((album) => album.id === id)).filter((album): album is ContentItem => Boolean(album));
	return <section className="photo-tools-search-view" aria-label="検索">
		<label className="photo-tools-search photo-tools-search--large"><Icon name="search" /><input type="search" autoFocus aria-label="アルバムと写真を検索" placeholder="アルバムと写真を検索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
		<ErrorBox error={error} />
		{!term && (recentAlbums.length
			? <>
				<div className="photo-tools-search-view__heading"><h2>最近見たアルバム</h2><button type="button" className="photo-tools-button photo-tools-button--ghost photo-tools-button--small" onClick={() => { try { localStorage.removeItem(RECENT_ALBUMS_KEY); } catch { /* ignore */ } setRecent([]); }}>クリア</button></div>
				<div className="photo-tools-banners">{recentAlbums.map((album) => <AlbumBanner key={album.id} album={album} onOpen={() => onOpenAlbum(album.id)} />)}</div>
			</>
			: <p className="photo-tools-note">アルバムの名前や、写真のタイトル・キャプションで探せます。</p>)}
		{term && <>
			{albumMatches.length > 0 && <><h2 className="photo-tools-search-view__label">アルバム</h2><div className="photo-tools-banners">{albumMatches.map((album) => <AlbumBanner key={album.id} album={album} onOpen={() => onOpenAlbum(album.id)} />)}</div></>}
			<h2 className="photo-tools-search-view__label">写真</h2>
			{photos.length
				? <div className="photo-tools-library__grid">{photos.map((photo) => <PhotoGridTile key={photo.id} photo={photo} onOpen={() => onOpenPhoto(textValue(dataOf(photo).album), photo.id)} />)}</div>
				: <p className="photo-tools-note" role="status">{loading ? "探しています…" : "一致する写真はありません。"}</p>}
		</>}
	</section>;
}

export function PhotoOrganizerPage() {
	useEffect(() => { startPerformanceAudit(); }, []);
	const [albums, setAlbums] = useState<ContentItem[]>([]);
	const [photos, setPhotos] = useState<ContentItem[]>([]);
	const [counts, setCounts] = useState<AlbumCount[]>([]);
	const [query, setQuery] = useState({q:"", filter:"", offset:0, photo: typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("photo") ?? ""});
	const [resultTotal, setResultTotal] = useState(0);
	const [firstOffset, setFirstOffset] = useState(0);
	const [nextOffset, setNextOffset] = useState<number | null>(null);
	const [selectedId, setSelectedId] = useState("");
	const [albumSearch, setAlbumSearch] = useState("");
	const [newTitle, setNewTitle] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [workspaceBusy, setWorkspaceBusy] = useState(false);
	const [photoIndexLoading, setPhotoIndexLoading] = useState(true);
	const [readyAlbumId, setReadyAlbumId] = useState("");
	const [albumHydration, setAlbumHydration] = useState<{ identity: string; status: "loading" | "ready" | "error"; error?: unknown } | null>(null);
	const [albumHydrationRetry, setAlbumHydrationRetry] = useState(0);
	const albumHydrationSequence = useRef(0);
	// "写真を追加" on the album list: choose the photos first, then where they go.
	const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
	const [uploadTarget, setUploadTarget] = useState("");

	useEffect(() => {
		allContent("albums", { orderBy: "captured_from", order: "desc" }).then((items) => {
			// Albums still being put together (drafts) come first; the rest stay newest first.
			const albumItems = [...items.filter((album) => album.status !== "published"), ...items.filter((album) => album.status === "published")];
			setAlbums(albumItems);
			const requested = new URLSearchParams(window.location.search).get("album");
			setSelectedId(requested && albumItems.some((album) => album.id === requested) ? requested : "");
		}).catch(setError).finally(() => setLoading(false));
		albumCounts().then(setCounts).catch(setError).finally(() => setPhotoIndexLoading(false));
	}, []);

	useEffect(() => {
		if (!selectedId) return;
		let cancelled = false;
		setReadyAlbumId("");
		const controller = new AbortController();
		photoPage(selectedId, query, controller.signal)
			.then((page) => {
				if (cancelled) return;
				// A fresh first page drops photos it no longer lists but keeps the edit
				// revisions already loaded for the ones it does (the open photo stays editable).
				setPhotos(current => {
					if (query.offset) return mergeEditableItems(current, page.items);
					const listed = new Set(page.items.map((item) => item.id));
					return mergeEditableItems(current.filter((item) => listed.has(item.id)), page.items);
				});
				if (!query.offset) setFirstOffset(page.offset);
				setResultTotal(page.total); setNextOffset(page.nextOffset); setReadyAlbumId(selectedId);
			}).catch(cause => { if (!cancelled) setError(cause); });
		return () => { cancelled = true; controller.abort(); };
	}, [selectedId, query]);
	const changeQuery = React.useCallback((q: string, filter: string) => {
		setQuery(current => current.q === q && current.filter === filter ? current : {q, filter, offset:0, photo:""});
	}, []);
	useEffect(() => {
		const timer = setTimeout(() => { albumCounts().then(setCounts).catch(setError); }, 500);
		return () => clearTimeout(timer);
	}, [photos]);
	// The owner's manual album order (SmugMug "Sort galleries: Manually"); albums added since come first.
	const [savedOrder, setSavedOrder] = useState<string[]>([]);
	const [reordering, setReordering] = useState<string[] | null>(null);
	const [savingOrder, setSavingOrder] = useState(false);
	const [orderMessage, setOrderMessage] = useState("");
	useEffect(() => { albumOrder().then(setSavedOrder).catch(() => setSavedOrder([])); }, []);
	const orderedAlbums = useMemo(() => {
		const rank = new Map(savedOrder.map((id, index) => [id, index]));
		const fresh = albums.filter((album) => !rank.has(album.id));
		const placed = albums.filter((album) => rank.has(album.id)).sort((left, right) => rank.get(left.id)! - rank.get(right.id)!);
		return [...fresh, ...placed];
	}, [albums, savedOrder]);
	const visibleAlbums = useMemo(() => {
		if (reordering) return reordering.map((id) => albums.find((album) => album.id === id)).filter((album): album is ContentItem => Boolean(album));
		const needle = albumSearch.trim().toLocaleLowerCase("ja");
		return needle ? orderedAlbums.filter(album => labelOf(album).toLocaleLowerCase("ja").includes(needle)) : orderedAlbums;
	}, [orderedAlbums, albums, albumSearch, reordering]);
	const albumReorder = usePointerReorder({
		enabled: Boolean(reordering) && !savingOrder,
		immediate: true,
		onMove: (from, to) => setReordering((current) => {
			if (!current) return current;
			const next = [...current]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next;
		}),
	});
	const saveOrder = async () => {
		if (!reordering) return;
		setSavingOrder(true); setError(null);
		try {
			setSavedOrder(await saveAlbumOrder(reordering));
			setReordering(null);
			setOrderMessage("アルバムの並び順を保存しました。公開サイトには数分で反映されます。");
		} catch (cause) { setError(cause); } finally { setSavingOrder(false); }
	};

	const selected = albums.find((album) => album.id === selectedId) ?? null;
	const selectedIdentity = selected ? `${selected.id}:${selected.draftRevisionId ?? ""}` : "";
	useEffect(() => {
		const sequence = ++albumHydrationSequence.current;
		if (!selected) {
			setAlbumHydration(null);
			return;
		}
		if (selected._rev) {
			setAlbumHydration({ identity: selectedIdentity, status: "ready" });
			return;
		}
		setAlbumHydration({ identity: selectedIdentity, status: "loading" });
		getContent("albums", selected.id).then((result) => {
			if (albumHydrationSequence.current !== sequence) return;
			setAlbums((current) => mergeEditableItems(current, [result.item]));
			setAlbumHydration({ identity: selectedIdentity, status: "ready" });
		}).catch((cause) => {
			if (albumHydrationSequence.current !== sequence) return;
			setAlbumHydration({ identity: selectedIdentity, status: "error", error: cause });
		});
		return () => { albumHydrationSequence.current += 1; };
	}, [selected?.id, selected?.draftRevisionId, selectedIdentity, albumHydrationRetry]);
	const selectedReady = Boolean(selected?._rev);

	// The two screens (album list, one album) live in the URL so Back works.
	useEffect(() => {
		const sync = () => {
			const params = new URLSearchParams(window.location.search);
			setQuery({ q: "", filter: "", offset: 0, photo: params.get("photo") ?? "" });
			setReadyAlbumId("");
			setPhotos([]);
			setSelectedId(params.get("album") ?? "");
			setTab(readTab());
		};
		window.addEventListener("popstate", sync);
		return () => window.removeEventListener("popstate", sync);
	}, []);
	const [tab, setTab] = useState<OrganizerTab>(readTab);
	const tabHref = (next: OrganizerTab) => next === "albums" ? ORGANIZER_ROOT : `${ORGANIZER_ROOT}?tab=${next}`;
	const switchTab = (next: OrganizerTab) => {
		if (next === tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
		window.history.pushState(null, "", tabHref(next));
		setTab(next);
		window.scrollTo({ top: 0 });
	};
	const openAlbum = (albumId: string, photoId = "") => {
		if (!albumId || workspaceBusy || !canChangeOrganizerContext()) return;
		window.history.pushState(null, "", organizerHref(albumId, photoId || undefined));
		rememberRecentAlbum(albumId);
		setReadyAlbumId(""); setQuery({ q: "", filter: "", offset: 0, photo: photoId }); setPhotos([]); setSelectedId(albumId);
		window.scrollTo({ top: 0 });
	};
	// Back from an album returns to the tab it was opened from.
	const closeAlbum = () => {
		window.history.pushState(null, "", tabHref(tab));
		setSelectedId(""); setPhotos([]);
		window.scrollTo({ top: 0 });
	};
	const createAlbum = async () => {
		if (!newTitle.trim()) return;
		setCreating(true); setError(null);
		try {
			const result = await createAlbumDraft(newTitle.trim());
			setAlbums((current) => [result.item, ...current]);
			setNewTitle(""); setShowNew(false);
			openAlbum(result.item.id);
		} catch (cause) { setError(cause); } finally { setCreating(false); }
	};
	const sendPendingFiles = async () => {
		if (!pendingFiles?.length) return;
		if (uploadTarget === "__new") { await createAlbum(); return; }
		if (uploadTarget) openAlbum(uploadTarget);
	};

	if (selectedId) {
		return <main className="photo-tools-shell">
			<ErrorBox error={error} />
			{selected && selectedReady
				? <AlbumOrganizer key={selected.id} pendingFiles={pendingFiles ?? undefined} onPendingFilesTaken={() => setPendingFiles(null)} album={selected} albums={albums} allPhotos={photos} onAlbumUpdated={(updated) => setAlbums((current) => mergeEditableItems(current, [updated]))} onPhotoUpdated={(updated) => setPhotos((current) => current.some(photo => photo.id === updated.id) ? mergeEditableItems(current, [updated]) : current)} onPhotoAdded={(created) => setPhotos((current) => mergeEditableItems(current, [created]))} onPhotoRemoved={(id) => setPhotos((current) => current.filter((photo) => photo.id !== id))} onBusyChange={setWorkspaceBusy} albumReady={readyAlbumId === selected.id} firstOffset={firstOffset} onFirstPage={() => setQuery(current => ({...current,offset:0,photo:""}))} onQuery={changeQuery} onRefresh={() => setQuery(current => ({...current,offset:0}))} nextOffset={nextOffset} resultTotal={resultTotal} albumCount={counts.find(count=>count.album===selected.id)} onLoadMore={() => { if (canChangeOrganizerContext() && nextOffset !== null) setQuery(current=>({...current,offset:nextOffset})); }} onBack={closeAlbum} />
				: selected && albumHydration?.identity === selectedIdentity && albumHydration.status === "error"
					? <section className="photo-tools-workspace"><ErrorBox error={albumHydration.error} /><button type="button" className="photo-tools-button" onClick={() => setAlbumHydrationRetry((value) => value + 1)}>再試行</button></section>
					: loading || selected
						? <p className="photo-tools-note" role="status">アルバムを読み込んでいます…</p>
						: <section className="photo-tools-workspace"><p className="photo-tools-empty">このアルバムは見つかりませんでした。</p><button type="button" className="photo-tools-button" onClick={closeAlbum}>アルバム一覧へ</button></section>}
		</main>;
	}

	return <main className="photo-tools-shell has-tabs">
		<header className="photo-tools-page-header">
			<div>
				<h1>写真を整理</h1>
				<p>アルバムを開いて、写真の追加・編集・並べ替え・公開をします。</p>
			</div>
			<div className="photo-tools-actions">
				{tab === "albums" && <button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={loading || Boolean(reordering)} onClick={() => { setOrderMessage(""); setAlbumSearch(""); setReordering(orderedAlbums.map((album) => album.id)); }}>並べ替え</button>}
				<button type="button" className="photo-tools-button" onClick={() => { if (tab !== "albums") switchTab("albums"); setShowNew((value) => !value); }} aria-expanded={showNew}><Icon name="plus" />新しいアルバム</button>
				<label className="photo-tools-button photo-tools-button--primary photo-tools-upload"><Icon name="upload" />写真を追加<input type="file" accept={ACCEPTED_IMAGE_INPUT} multiple hidden onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					event.currentTarget.value = "";
					if (!files.length) return;
					if (tab !== "albums") switchTab("albums");
					setPendingFiles(files); setShowNew(false);
					setUploadTarget((current) => current || albums[0]?.id || "__new");
				}} /></label>
			</div>
		</header>
		<OrganizerTabs tab={tab} onChange={switchTab} />
		{tab === "library" && <LibraryView onOpen={(albumId, photoId) => openAlbum(albumId, photoId)} />}
		{tab === "search" && <SearchView albums={orderedAlbums} onOpenAlbum={(id) => openAlbum(id)} onOpenPhoto={(albumId, photoId) => openAlbum(albumId, photoId)} />}
		{tab === "albums" && <>
			{pendingFiles && <form className="photo-tools-create photo-tools-destination" onSubmit={(event) => { event.preventDefault(); void sendPendingFiles(); }}>
				<p><strong>{pendingFiles.length}点の写真</strong>を追加します。追加先を選んでください。</p>
				<label>追加先のアルバム<select value={uploadTarget} disabled={creating} onChange={(event) => setUploadTarget(event.target.value)}>
					<option value="__new">新しいアルバムを作る</option>
					{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}{album.status !== "published" ? "（下書き）" : ""}</option>)}
				</select></label>
				{uploadTarget === "__new" && <label>新しいアルバムの名前<input autoFocus value={newTitle} placeholder="例：Kyoto, 2026/10" disabled={creating} onChange={(event) => setNewTitle(event.target.value)} /></label>}
				<button type="submit" className="photo-tools-button photo-tools-button--primary" disabled={creating || !uploadTarget || (uploadTarget === "__new" && !newTitle.trim())}>{creating ? "作成中…" : "このアルバムに追加"}</button>
				<button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={creating} onClick={() => setPendingFiles(null)}>やめる</button>
			</form>}
			{showNew && <form className="photo-tools-create" onSubmit={(event) => { event.preventDefault(); void createAlbum(); }}>
				<label>新しいアルバムの名前<input autoFocus value={newTitle} placeholder="例：Kyoto, 2026/10" disabled={creating} onChange={(event) => setNewTitle(event.target.value)} /></label>
				<button type="submit" className="photo-tools-button photo-tools-button--primary" disabled={creating || !newTitle.trim()}>{creating ? "作成中…" : "作成して写真を追加"}</button>
				<button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={creating} onClick={() => { setShowNew(false); setNewTitle(""); }}>キャンセル</button>
			</form>}
			<ErrorBox error={error} />
			<AdminSetupCard />
			{orderMessage && <p className="photo-tools-status" role="status">{orderMessage}</p>}
			{reordering && <div className="photo-tools-reorder-bar" role="region" aria-label="アルバムの並べ替え">
				<span>アルバムをドラッグして並べ替えます（公開サイトの並び順になります）</span>
				<button type="button" className="photo-tools-button photo-tools-button--primary" disabled={savingOrder} onClick={() => void saveOrder()}>{savingOrder ? "保存中…" : "完了"}</button>
				<button type="button" className="photo-tools-button photo-tools-button--ghost" disabled={savingOrder} onClick={() => setReordering(null)}>やめる</button>
			</div>}
			{!reordering && <div className="photo-tools-toolbar photo-tools-toolbar--albums">
				<label className="photo-tools-search"><Icon name="search" /><input type="search" aria-label="アルバムを検索" placeholder="アルバムを検索" value={albumSearch} onChange={(event) => setAlbumSearch(event.target.value)} /></label>
				<span className="photo-tools-toolbar__count">{loading ? "読み込み中…" : `${visibleAlbums.length}件`}</span>
			</div>}
			{loading
				? <p className="photo-tools-note" role="status">アルバムを読み込んでいます…</p>
				: visibleAlbums.length
					? <ul className={`photo-tools-albums ${reordering ? "is-reordering" : ""}`}>{visibleAlbums.map((album, index) => {
						const count = counts.find((entry) => entry.album === album.id);
						const from = dateTimeLocalInputValue(dataOf(album).captured_from).slice(0, 7).replace("-", "/");
						const state = album.status !== "published" ? "下書き" : hasPendingChanges(album) || (count?.pending ?? 0) > 0 ? "未公開の変更" : "";
						return <li key={album.id} data-reorder-index={index} onPointerDown={(event) => albumReorder.start(event, index)} className={`${albumReorder.dragging === index ? "is-dragging" : ""} ${albumReorder.dragging !== null && albumReorder.over === index && albumReorder.dragging !== index ? "is-drop-target" : ""}`}>
							<a className="photo-tools-album-card" href={organizerHref(album.id)} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); if (!reordering) openAlbum(album.id); }}>
								<span className="photo-tools-album-card__cover">{dataOf(album).cover_image ? <Preview value={dataOf(album).cover_image} size={480} /> : <span className="photo-tools-album-card__empty"><Icon name="image" size={20} />{(count?.total ?? 0) > 0 ? "表紙が未設定" : "写真なし"}</span>}</span>
								<span className="photo-tools-album-card__body">
									<strong>{labelOf(album)}</strong>
									<small>{photoIndexLoading ? "…" : `${count?.total ?? 0}点`}{from && <> · {from}</>}</small>
								</span>
								{state && <span className={`photo-tools-flag ${album.status !== "published" ? "photo-tools-flag--muted" : "photo-tools-flag--warn"}`}>{state}</span>}
								{reordering && <span className="photo-tools-album-card__handle" aria-hidden="true">≡</span>}
							</a>
						</li>;
					})}</ul>
					: <p className="photo-tools-empty">{albumSearch ? "一致するアルバムはありません。" : "アルバムがありません。「新しいアルバム」から作成してください。"}</p>}
		</>}
	</main>;
}

function ThumbnailColumn({ item }: ContentListColumnCellContext) {
	return <span className="photo-tools-column-thumb"><Preview value={dataOf(item).image} size={56} /></span>;
}

function PhotoLabelColumn({ item }: ContentListColumnCellContext) {
	const albumId = textValue(dataOf(item).album);
	return <span><a href={albumId ? organizerHref(albumId, item.id) : photoEditHref(item.id)}>{photoTitleOf(item) || capturedLabelOf(item) || "タイトル未設定"}</a><small className="photo-tools-column-date">{textValue((dataOf(item).image as Record<string, unknown> | undefined)?.filename)}</small></span>;
}

function PhotoStateColumn({ item }: ContentListColumnCellContext) {
	return <span><Badge tone={hasPendingChanges(item) ? "warn" : "ok"}>{statusLabel(item)}</Badge><small className="photo-tools-column-date">{String(item.updatedAt ?? "").slice(0, 10)}</small></span>;
}

let albumMapPromise: Promise<Map<string, string>> | null = null;
function loadAlbumMap() {
	albumMapPromise ??= allContent("albums").then((albums) => new Map(albums.map((album) => [album.id, labelOf(album)])));
	return albumMapPromise;
}

function AlbumColumn({ item }: ContentListColumnCellContext) {
	const [name, setName] = useState("読込中…");
	const id = textValue(dataOf(item).album);
	useEffect(() => { loadAlbumMap().then((map) => setName(map.get(id) ?? "不明なアルバム")).catch(() => setName("取得失敗")); }, [id]);
	return id ? <a href={organizerHref(id, item.id)}>{name}</a> : <span>{name}</span>;
}

function ReviewColumn({ item }: ContentListColumnCellContext) {
	const flags = photoReviewFlags(dataOf(item), { status: item.status });
	return <div className="photo-tools-badges">{flags.length ? flags.map((flag) => <Badge key={flag} tone={flag === "has-location" || flag === "location-unreviewed" ? "danger" : "warn"}>{FLAG_LABELS[flag]}</Badge>) : <Badge tone="ok">確認済み</Badge>}</div>;
}

function AlbumPhotoPanel({ entry }: ContentEditorPanelContext) {
	const [photos, setPhotos] = useState<ContentItem[]>([]);
	const [error, setError] = useState<unknown>(null);
	const entryId = entry?.id;
	useEffect(() => {
		if (!entryId) {
			// A new album: once it is saved, go straight to adding photos.
			try { sessionStorage.setItem(NEW_ALBUM_FLAG, "1"); } catch { /* storage unavailable */ }
			return;
		}
		allContent("photos", { fieldFilters: { album: entryId }, orderBy: "position", order: "asc" }).then((items) => {
			setPhotos(items);
			let justCreated = false;
			try { justCreated = sessionStorage.getItem(NEW_ALBUM_FLAG) === "1"; sessionStorage.removeItem(NEW_ALBUM_FLAG); } catch { /* storage unavailable */ }
			const createdAt = Date.parse(String(entry?.createdAt ?? ""));
			if (justCreated && items.length === 0 && Date.now() - createdAt < 10 * 60_000) window.location.assign(organizerHref(entryId));
		}).catch(setError);
	}, [entryId]);
	if (!entry) return <div className="photo-tools-panel"><p className="photo-tools-muted">保存すると、写真を追加する画面に移ります。</p></div>;
	const published = photos.filter((photo) => !hasPendingChanges(photo)).length;
	const live = publicHref(entry, "album");
	return <div className="photo-tools-panel"><p><strong>{photos.length}点</strong>{photos.length > 0 && `（公開済み ${published}・未公開の変更 ${photos.length - published}）`}</p><div className="photo-tools-panel-grid">{photos.slice(0, 24).map((photo) => <a key={photo.id} href={organizerHref(entry.id, photo.id)} title={`${labelOf(photo)}を整理`}><Preview value={dataOf(photo).image} size={72} /></a>)}</div>{photos.length > 24 && <p className="photo-tools-muted">ほか {photos.length - 24}点</p>}<div className="photo-tools-panel-actions"><a className="photo-tools-button photo-tools-button--primary" href={organizerHref(entry.id)}>{photos.length ? "写真を追加・整理" : "写真を追加"}</a>{live && entry.status === "published" && <a className="photo-tools-button" href={live} target="_blank" rel="noreferrer">公開ページを見る</a>}</div><ErrorBox error={error} /></div>;
}

function PhotoOrganizerPanel({ entry }: ContentEditorPanelContext) {
	const albumId = textValue(dataOf(entry).album);
	return <div className="photo-tools-panel">
		<p className="photo-tools-muted">アルバム内の並べ替え、移動、一括操作は「写真を整理」で行います。</p>
		{needsLocationReview(dataOf(entry)) && <p className="photo-tools-alert photo-tools-alert--error">この写真は原本の位置情報が未確認です。位置情報除去手順を完了するまで公開しないでください。</p>}
		{albumId
			? <a className="photo-tools-button photo-tools-button--primary" href={organizerHref(albumId, entry.id)}>この写真を整理</a>
			: <p>所属アルバムを設定すると、写真整理画面を開けます。</p>}
	</div>;
}

type RelatedAlbumPanelContext = Omit<ContentEditorPanelContext, "entry"> & {
	entry?: ContentItem;
	draftData?: Record<string, unknown>;
	onFieldChange?: (name: string, value: unknown) => void;
};

type RelatedAlbumSchemaField = {
	slug?: unknown;
	type?: unknown;
	required?: unknown;
	unique?: unknown;
	options?: { collection?: unknown };
	widget?: unknown;
	indexed?: unknown;
	translatable?: unknown;
};

type RelatedAlbumSchemaState =
	| { status: "loading" | "activating" }
	| { status: "missing" | "ready" | "reload-required" }
	| { status: "incompatible"; problems: string[] }
	| { status: "error"; error: unknown };

const RELATED_ALBUM_SCHEMA_PATH = "/_emdash/api/schema/collections/posts/fields";
const RELATED_ALBUM_FIELD = {
	slug: "related_album",
	label: "関連アルバム",
	type: "reference",
	required: false,
	unique: false,
	options: { collection: "albums" },
	widget: "yohaku-photo-tools:related-album-hidden",
	indexed: true,
	translatable: true,
} as const;

function inspectRelatedAlbumSchema(fields: RelatedAlbumSchemaField[]): RelatedAlbumSchemaState {
	const field = fields.find((candidate) => candidate.slug === RELATED_ALBUM_FIELD.slug);
	if (!field) return { status: "missing" };
	const problems: string[] = [];
	if (field.type !== RELATED_ALBUM_FIELD.type) problems.push("型がreferenceではありません。");
	if (field.required !== false) problems.push("任意フィールドとして確認できません。");
	if (field.unique !== false) problems.push("複数の記事から同じアルバムを参照できない設定です。");
	if (field.options?.collection !== RELATED_ALBUM_FIELD.options.collection) problems.push("参照先がalbumsではありません。");
	if (field.widget !== RELATED_ALBUM_FIELD.widget) problems.push("専用widgetが設定されていません。");
	if (field.indexed !== true) problems.push("indexが設定されていません。");
	if (field.translatable !== true) problems.push("言語別の値を保持できない設定です。");
	return problems.length ? { status: "incompatible", problems } : { status: "ready" };
}

async function readRelatedAlbumSchema(): Promise<RelatedAlbumSchemaState> {
	const data = await parseApiResponse<{ items?: RelatedAlbumSchemaField[] }>(
		await apiFetch(RELATED_ALBUM_SCHEMA_PATH),
		"関連アルバム設定を確認できませんでした。",
	);
	if (!Array.isArray(data.items)) throw new Error("関連アルバム設定の応答形式が正しくありません。");
	return inspectRelatedAlbumSchema(data.items);
}

function RelatedAlbumPanel({ entry, draftData, onFieldChange }: RelatedAlbumPanelContext) {
	const [albums, setAlbums] = useState<ContentItem[]>([]);
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [schemaState, setSchemaState] = useState<RelatedAlbumSchemaState>({ status: "loading" });
	const data = draftData ?? entry?.data ?? {};
	const selectedId = textValue(data.related_album);
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		allContent("albums")
			.then((items) => { if (active) setAlbums(items); })
			.catch((cause) => { if (active) setError(cause); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, []);
	useEffect(() => {
		let active = true;
		readRelatedAlbumSchema()
			.then((state) => { if (active) setSchemaState(state); })
			.catch((cause) => { if (active) setSchemaState({ status: "error", error: cause }); });
		return () => { active = false; };
	}, []);
	const selected = albums.find((album) => album.id === selectedId);
	const visibleAlbums = useMemo(() => {
		const term = search.trim().toLocaleLowerCase("ja");
		return albums
			.filter((album) => album.id === selectedId || !term || labelOf(album).toLocaleLowerCase("ja").includes(term))
			.sort((left, right) => labelOf(left).localeCompare(labelOf(right), "ja"));
	}, [albums, search, selectedId]);
	const change = (albumId: string) => onFieldChange?.("related_album", albumId);
	const enableRelatedAlbum = async () => {
		setSchemaState({ status: "activating" });
		try {
			const before = await readRelatedAlbumSchema();
			if (before.status === "incompatible") {
				setSchemaState(before);
				return;
			}
			if (before.status === "missing") {
				await parseApiResponse(
					await apiFetch(RELATED_ALBUM_SCHEMA_PATH, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(RELATED_ALBUM_FIELD),
					}),
					"関連アルバム設定を有効にできませんでした。管理者権限を確認してください。",
				);
			}
			const after = await readRelatedAlbumSchema();
			if (after.status !== "ready") {
				setSchemaState(after.status === "missing"
					? { status: "error", error: new Error("設定追加後の確認でrelated_albumが見つかりませんでした。") }
					: after);
				return;
			}
			setSchemaState({ status: "reload-required" });
		} catch (cause) {
			setSchemaState({ status: "error", error: cause });
		}
	};
	const schemaReady = schemaState.status === "ready";

	return <div className="photo-tools-panel photo-tools-related-album-panel">
		{schemaState.status === "loading" && <p className="photo-tools-muted" role="status">関連アルバム設定を確認しています…</p>}
		{schemaState.status === "missing" && <div className="photo-tools-alert" role="status">
			<p>関連アルバムを保存するフィールドがまだありません。</p>
			<button type="button" className="photo-tools-button photo-tools-button--primary" onClick={enableRelatedAlbum}>関連アルバム設定を有効にする</button>
		</div>}
		{schemaState.status === "activating" && <p className="photo-tools-muted" role="status">関連アルバム設定を有効にしています…</p>}
		{schemaState.status === "reload-required" && <div className="photo-tools-alert" role="status">
			<p>関連アルバム設定を追加し、定義を再確認しました。このページを再読込してからアルバムを選んでください。</p>
			<button type="button" className="photo-tools-button photo-tools-button--primary" onClick={() => window.location.reload()}>ページを再読込</button>
		</div>}
		{schemaState.status === "incompatible" && <div className="photo-tools-alert photo-tools-alert--error" role="alert">
			<p>既存のrelated_album定義が予定した設定と一致しないため、自動変更を停止しました。</p>
			<ul>{schemaState.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
		</div>}
		{schemaState.status === "error" && <div className="photo-tools-alert photo-tools-alert--error" role="alert">
			<p>{schemaState.error instanceof Error ? schemaState.error.message : "関連アルバム設定の操作に失敗しました。"}</p>
			<button type="button" className="photo-tools-button" onClick={() => {
				setSchemaState({ status: "loading" });
				readRelatedAlbumSchema()
					.then(setSchemaState)
					.catch((cause) => setSchemaState({ status: "error", error: cause }));
			}}>設定状態を再確認</button>
		</div>}
		{selectedId
			? <p>現在: <strong>{selected ? labelOf(selected) : "削除済み、または参照できないアルバム"}</strong>{selected && <> <Badge tone={hasPendingChanges(selected) ? "warn" : "ok"}>{statusLabel(selected)}</Badge></>}</p>
			: <p className="photo-tools-muted">関連アルバムは未設定です。</p>}
		<label>アルバムを検索<input type="search" value={search} disabled={!schemaReady} onChange={(event) => setSearch(event.target.value)} placeholder="アルバム名" /></label>
		<label>関連アルバム<select value={selectedId} disabled={!schemaReady || loading || !onFieldChange} onChange={(event) => change(event.target.value)}>
			<option value="">関連なし</option>
			{selectedId && !selected && <option value={selectedId}>参照できないアルバム（現在の設定を維持）</option>}
			{visibleAlbums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}（{statusLabel(album)}）</option>)}
		</select></label>
		<div className="photo-tools-panel-actions">
			<button type="button" className="photo-tools-button" disabled={!schemaReady || !selectedId || !onFieldChange} onClick={() => change("")}>関連を解除</button>
		</div>
		<p className="photo-tools-muted">記事の下書きに保存されます。解除しても、本文のアルバムカードや挿入済み写真・キャプションは残ります。</p>
		{loading && <p className="photo-tools-muted" role="status">アルバムを読み込んでいます…</p>}
		<ErrorBox error={error} />
	</div>;
}

function HiddenRelatedAlbumField() {
	return null;
}

type FieldWidgetProps = { value: unknown; onChange: (value: unknown) => void; label?: string; id?: string; required?: boolean };

/** Album field of the standard photo editor: choose an album instead of typing its ID. */
function AlbumPickerField({ value, onChange, label, id }: FieldWidgetProps) {
	const [albums, setAlbums] = useState<ContentItem[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => { allContent("albums").then(setAlbums).catch(setError); }, []);
	const current = textValue(value);
	const sorted = useMemo(() => (albums ?? []).toSorted((left, right) => labelOf(left).localeCompare(labelOf(right), "ja", { numeric: true })), [albums]);
	return <div className="photo-tools-panel photo-tools-field">
		<label htmlFor={id}>{label ?? "アルバム"}</label>
		<select id={id} value={current} disabled={!albums} onChange={(event) => onChange(event.target.value)}>
			{!current && <option value="">アルバムを選ぶ</option>}
			{albums && current && !albums.some((album) => album.id === current) && <option value={current}>（見つからないアルバム）</option>}
			{sorted.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}
		</select>
		{!albums && !error && <small className="photo-tools-muted">アルバムを読み込んでいます…</small>}
		<ErrorBox error={error} />
		{current && <small className="photo-tools-muted"><a href={organizerHref(current)}>このアルバムを「写真を整理」で開く</a></small>}
	</div>;
}

/** Internal fields (order, import source, checksums) shown but not editable in the standard editor. */
function ReadonlyField({ value, label }: FieldWidgetProps) {
	const text = value === undefined || value === null || value === ""
		? "（なし）"
		: typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
	return <div className="photo-tools-panel photo-tools-field photo-tools-field--readonly">
		<span className="photo-tools-field__label">{label}<small>自動で管理される項目です</small></span>
		{typeof value === "object" && value !== null ? <details><summary>内容を見る</summary><pre>{text}</pre></details> : <output>{text}</output>}
	</div>;
}

/** Dashboard card: the way into photo work, since plugin pages sit at the bottom of the sidebar. */
function OrganizeShortcutWidget() {
	const [albums, setAlbums] = useState<ContentItem[]>([]);
	useEffect(() => { allContent("albums", { orderBy: "captured_from", order: "desc" }).then((items) => setAlbums(items.slice(0, 4))).catch(() => setAlbums([])); }, []);
	return <div className="photo-tools-panel photo-tools-widget">
		<p>アルバムを開いて、写真の追加・編集・並べ替え・公開をします。</p>
		{albums.length > 0 && <ul>{albums.map((album) => <li key={album.id}><a href={organizerHref(album.id)}>{dataOf(album).cover_image ? <Preview value={dataOf(album).cover_image} size={160} /> : <span className="photo-tools-thumb photo-tools-thumb--empty" />}<span>{labelOf(album)}</span></a></li>)}</ul>}
		<div className="photo-tools-panel-actions"><a className="photo-tools-button photo-tools-button--primary" href={ORGANIZER_ROOT}>写真を整理を開く</a></div>
	</div>;
}

export const contentListColumns: readonly ContentListColumnExtension[] = [
	{ id: "photo-thumbnail", label: "写真", collections: ["photos"], order: -30, cell: ThumbnailColumn },
	{ id: "photo-label", label: "タイトル／キャプション", collections: ["photos"], order: -25, cell: PhotoLabelColumn },
	{ id: "photo-album", label: "アルバム", collections: ["photos"], order: -20, cell: AlbumColumn },
	{ id: "photo-review", label: "要確認", collections: ["photos"], order: -10, cell: ReviewColumn },
	{ id: "photo-state", label: "状態／更新", collections: ["photos"], order: -5, cell: PhotoStateColumn },
];

type ContentEditorPanelWithNewEntry = ContentEditorPanelExtension & { supportsNew?: boolean };

export const contentEditorPanels: readonly ContentEditorPanelWithNewEntry[] = [
	{ id: "post-related-album", title: "関連アルバム", collections: ["posts"], order: -30, supportsNew: true, component: RelatedAlbumPanel },
	{ id: "album-photos", title: "アルバムの写真", collections: ["albums"], order: -20, supportsNew: true, component: AlbumPhotoPanel },
	{ id: "photo-organizer", title: "アルバムで整理", collections: ["photos"], order: -20, component: PhotoOrganizerPanel },
];

export const fields = { "related-album-hidden": HiddenRelatedAlbumField, "album-picker": AlbumPickerField, readonly: ReadonlyField };
export const widgets = { "organize-shortcut": OrganizeShortcutWidget };
export const pages = { "/organize": PhotoOrganizerPage };
