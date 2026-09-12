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
	albumCounts, photoPage, albumPhotosForOperation, type AlbumCount,
	createPhotoFromMedia,
	createAlbumDraft,
	getContent,
	publishDraft,
	recordOperation,
	PhotoToolsApiError,
	updateDraft,
	uploadPhotoMedia,
	type PhotoMediaItem,
	type ContentItem,
} from "./api";
import {
	applyBulkPatch,
	compareCapturedAt,
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
	isUploadQueueRetryable,
	isUploadQueueSettled,
	dateTimeLocalInputValue,
	mergeEditableItems,
	preparePhotoDraftPatch,
	publicImageVariantPath,
	retryFailedUploadQueue,
	updateUploadQueueItem,
	type UploadQueueItem,
} from "./organizer-workflow";
import "./studio.css";

const CORE_ROOT = "/_emdash/admin";
const ORGANIZER_ROOT = "/_emdash/admin/plugins/yohaku-photo-tools/organize";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ACCEPTED_IMAGE_INPUT = [...ACCEPTED_IMAGE_TYPES].join(",");

const UPLOAD_STAGE_LABELS: Record<UploadQueueItem<File, PhotoMediaItem>["stage"], string> = {
	queued: "待機中",
	"uploading-media": "Mediaを保存中",
	"media-ready": "Media保存済み",
	"creating-photo": "Photo下書きを作成中",
	"photo-created": "Photo下書き作成済み",
	"failed-validation": "追加対象外",
	"failed-media": "Media保存失敗",
	"failed-photo": "Photo作成失敗",
};

const FLAG_LABELS: Record<ReviewFlag, string> = {
	"missing-caption": "キャプションなし",
	"missing-alt": "altなし",
	"has-location": "位置情報あり",
	"location-unreviewed": "原本の位置情報未確認",
	"unpublished": "未公開",
};

function dataOf(item: ContentItem): Record<string, unknown> {
	return item.data ?? {};
}

function labelOf(item: ContentItem): string {
	const data = dataOf(item);
	return textValue(data.caption) || textValue(data.title) || item.slug || item.id;
}

function hasPendingChanges(item: ContentItem): boolean {
	return item.status !== "published" || Boolean(
		item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId,
	);
}

function statusLabel(item: ContentItem): string {
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

function PhotoInspector({
	photo,
	albums,
	busy,
	onSave,
	onPublish,
	onDirtyChange,
	previousId,
	nextId,
	onNavigate,
}: {
	photo: ContentItem;
	albums: ContentItem[];
	busy: boolean;
	onSave: (photo: ContentItem, patch: Record<string, unknown>) => Promise<boolean>;
	onPublish: (ids: string[]) => Promise<void>;
	onDirtyChange: (dirty: boolean) => void;
	previousId: string | null;
	nextId: string | null;
	onNavigate: (photoId: string) => void;
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
	return <aside className="photo-tools-inspector" aria-label="写真情報" data-photo-tools-dirty={dirty ? "true" : undefined}>
		<header><div><span className="photo-tools-eyebrow">写真情報</span><h2>{labelOf(photo)}</h2></div><Badge tone={dirty || hasPendingChanges(photo) ? "warn" : "ok"}>{dirty ? "未保存" : statusLabel(photo)}</Badge></header>
		<Preview value={dataOf(photo).image} size={480} />
		<label>タイトル<input value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
		<label>キャプション<textarea value={draft.caption} disabled={busy} placeholder="キャプションを追加" onChange={(event) => setDraft({ ...draft, caption: event.target.value })} /></label>
		<label>代替テキスト<input value={draft.alt} disabled={busy} onChange={(event) => setDraft({ ...draft, alt: event.target.value })} /></label>
		<label>撮影日<input type="datetime-local" value={draft.captured_at} disabled={busy} onChange={(event) => setDraft({ ...draft, captured_at: event.target.value })} /></label>
		<label>アルバム<select value={draft.album} disabled={busy} onChange={(event) => setDraft({ ...draft, album: event.target.value })}>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
		<nav className="photo-tools-caption-nav" aria-label="連続キャプション編集">
			<button type="button" className="photo-tools-button" disabled={busy || saving || !previousId || Boolean(preparedDraft.dateError) || (dirty && (!draft.title.trim() || !draft.alt.trim()))} onClick={() => saveAndNavigate(previousId)}>{dirty ? "保存して前へ" : "前へ"}</button>
			<button type="button" className="photo-tools-button photo-tools-button--primary" disabled={busy || saving || !dirty || Boolean(preparedDraft.dateError) || !draft.title.trim() || !draft.alt.trim()} onClick={() => saveDraft()}>{saving ? "保存中…" : "下書き保存"}</button>
			<button type="button" className="photo-tools-button" disabled={busy || saving || !nextId || Boolean(preparedDraft.dateError) || (dirty && (!draft.title.trim() || !draft.alt.trim()))} onClick={() => saveAndNavigate(nextId)}>{dirty ? "保存して次へ" : "次へ"}</button>
		</nav>
		{preparedDraft.dateError && <p className="photo-tools-alert photo-tools-alert--error" role="alert">{preparedDraft.dateError}</p>}
		<div className="photo-tools-actions">
			<button className="photo-tools-button" disabled={busy || dirty || locationUnreviewed || !hasPendingChanges(photo)} onClick={() => onPublish([photo.id])}>この写真だけ公開</button>
			<a className="photo-tools-button" href={photoEditHref(photo.id)} onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>詳細編集</a>
		</div>
		<PublicPhotoLinks photo={photo} />
		{dirty && <p className="photo-tools-muted">この写真の変更を下書き保存すると、公開や並べ替えを再開できます。</p>}
		{locationUnreviewed && <p className="photo-tools-alert photo-tools-alert--error">原本の位置情報を確認・除去するまで公開できません。</p>}
	</aside>;
}

function BulkInspector({
	selected,
	albums,
	busy,
	onApply,
	onMove,
	onPublish,
	onClear,
}: {
	selected: ContentItem[];
	albums: ContentItem[];
	busy: boolean;
	onApply: (field: "caption" | "alt", value: string, mode: BulkTextMode) => Promise<void>;
	onMove: (albumId: string) => Promise<void>;
	onPublish: (ids: string[]) => Promise<void>;
	onClear: () => void;
}) {
	const [field, setField] = useState<"caption" | "alt">("caption");
	const [mode, setMode] = useState<BulkTextMode>("overwrite");
	const [value, setValue] = useState("");
	const [target, setTarget] = useState("");
	return <aside className="photo-tools-inspector" aria-label="一括操作">
		<header><div><span className="photo-tools-eyebrow">一括操作</span><h2>{selected.length}点を選択中</h2></div></header>
		<p className="photo-tools-muted">処理中は対象を固定し、失敗した写真だけを選択状態に残します。</p>
		<label>変更項目<select value={field} disabled={busy} onChange={(event) => setField(event.target.value as "caption" | "alt")}><option value="caption">キャプション</option><option value="alt">代替テキスト</option></select></label>
		<label>変更方法<select value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as BulkTextMode)}><option value="overwrite">上書き</option><option value="prepend">先頭へ追加</option><option value="append">末尾へ追加</option></select></label>
		<label>内容<textarea value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} /></label>
		<button className="photo-tools-button photo-tools-button--primary" disabled={busy || !value.trim()} onClick={async () => {
			if (mode === "overwrite" && !window.confirm(`${selected.length}点の${field === "caption" ? "キャプション" : "代替テキスト"}を同じ内容で上書きしますか？`)) return;
			await onApply(field, value, mode); setValue("");
		}}>下書きへ適用</button>
		<hr />
		<label>移動先<select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}><option value="">選択してください</option>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
		<button className="photo-tools-button" disabled={busy || !target} onClick={() => onMove(target)}>選択した写真を移動</button>
		<hr />
		<div className="photo-tools-actions"><button className="photo-tools-button" disabled={busy || !selected.some(hasPendingChanges)} onClick={() => onPublish(selected.map((photo) => photo.id))}>選択した写真を公開</button><button className="photo-tools-button" disabled={busy} onClick={onClear}>選択解除</button></div>
	</aside>;
}

function AlbumOrganizer({
	album,
	albums,
	allPhotos,
	onAlbumUpdated,
	onPhotoUpdated,
	onPhotoAdded,
	onBusyChange,
	albumReady,
	onQuery, onRefresh, onFirstPage, firstOffset, onLoadMore, nextOffset, resultTotal, albumCount,
}: {
	album: ContentItem;
	albums: ContentItem[];
	allPhotos: ContentItem[];
	onAlbumUpdated: (item: ContentItem) => void;
	onPhotoUpdated: (item: ContentItem) => void;
	onPhotoAdded: (item: ContentItem) => void;
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
}) {
	const reorderInFlight = useRef(false);
	const albumPhotos = useMemo(() => allPhotos
		.filter((photo) => dataOf(photo).album === album.id)
		.toSorted((left, right) => Number(dataOf(left).position) - Number(dataOf(right).position)), [allPhotos, album.id]);
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
		setPhotoDraftDirty(false);
		setUploadQueue([]);
		setAlbumDraft({ title: textValue(dataOf(album).title), description: textValue(dataOf(album).description) });
		setMessage(""); setError(null); setFailures([]);
	}, [album.id]);
	useEffect(() => {
		if (selectedId && albumPhotos.some((photo) => photo.id === selectedId)) return;
		const requested = new URLSearchParams(window.location.search).get("photo");
		setSelectedId(requested && albumPhotos.some((photo) => photo.id === requested) ? requested : albumPhotos[0]?.id ?? null);
	}, [album.id, albumPhotos, selectedId]);

	useEffect(() => {
		const timer = setTimeout(() => onQuery(search, filter), 250);
		return () => clearTimeout(timer);
	}, [search, filter, onQuery]);
	const visible = albumPhotos;

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
	}, [inspectorPhoto?.id, inspectorPhoto?.draftRevisionId, checkedPhotos.length, inspectorIdentity, photoHydrationRetry]);
	const inspectorReady = Boolean(inspectorPhoto?._rev);
	const albumDraftDirty = albumDraft.title.trim() !== textValue(dataOf(album).title) || albumDraft.description.trim() !== textValue(dataOf(album).description);
	const pendingIds = new Set([...albumPhotos.filter(hasPendingChanges).map((photo) => photo.id), ...touchedIds]);
	const workspacePending = albumDraftDirty || hasPendingChanges(album) || pendingIds.size > 0 || Boolean(albumCount?.pending);
	const live = publicHref(album, "album");
	const operationLocked = busy || !albumReady || photoDraftDirty;
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
		let positions = next.map(photo => Number(dataOf(photo).position) || 0).sort((a,b) => a-b);
		if (new Set(positions).size !== positions.length) {
			try {
				const full = await albumPhotosForOperation(album.id);
				const selected = new Set(next.map(photo => photo.id));
				let cursor = 0;
				next = full.map(photo => selected.has(photo.id) ? next[cursor++] : photo);
				positions = sparsePositions(next.length);
			} catch (cause) { setError(cause); setBusy(false); reorderInFlight.current = false; return; }
		}
		const changed = next.flatMap((photo, index) => Number(dataOf(photo).position) === positions[index] ? [] : [{ photo, position: positions[index] }]);
		setUndoOrder(changed.map(({ photo }) => ({ id: photo.id, position: Number(dataOf(photo).position) || 0 })));
		const failed: Failure[] = [];
		const succeeded: Array<{ id: string; position: number }> = [];
		for (const { photo, position } of changed) {
			try { const current = await getContent("photos", photo.id); const result = await updateDraft("photos", photo.id, current._rev, { position }); onPhotoUpdated(result.item); touch(photo.id); succeeded.push({ id: photo.id, position: Number(dataOf(photo).position) || 0 }); }
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
		setMessage(failed.length ? `並び順を完了できなかったため、保存済みの変更を元へ戻しました（${failed.length}件を確認してください）` : "並び順を下書き保存しました");
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

	const toggleChecked = (photoId: string) => {
		if (!canChangeOrganizerContext()) return;
		const next = new Set(checked);
		next.has(photoId) ? next.delete(photoId) : next.add(photoId);
		setChecked(next);
		if (next.size === 1) setSelectedId([...next][0]);
		else if (next.size === 0) setSelectedId(photoId);
		else if (!selectedId || !next.has(selectedId)) setSelectedId([...next][0]);
		setMobilePane("info");
	};

	const executeUploadQueue = async (initial: UploadQueueItem<File, PhotoMediaItem>[]) => {
		setBusy(true); setError(null); setFailures([]);
		let working = initial;
		const updateItem = (id: string, patch: Partial<Omit<UploadQueueItem<File, PhotoMediaItem>, "id" | "file" | "position">>) => {
			working = updateUploadQueueItem(working, id, patch);
			setUploadQueue(working);
		};
		const created: string[] = [];
		for (const queued of initial) {
			let item = working.find((candidate) => candidate.id === queued.id) ?? queued;
			if (item.stage === "queued") {
				updateItem(item.id, { stage: "uploading-media", error: undefined });
				setMessage(`${item.file.name}: Mediaを保存中…`);
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
			updateItem(item.id, { stage: "creating-photo", error: undefined });
			setMessage(`${item.file.name}: Photo下書きを作成中…`);
			try {
				const result = await createPhotoFromMedia(item.media, album.id, item.position);
				onPhotoAdded(result.item);
				touch(result.item.id);
				created.push(result.item.id);
				updateItem(item.id, { stage: "photo-created", photoId: result.item.id, error: undefined });
			} catch (cause) {
				updateItem(item.id, { stage: "failed-photo", media: item.media, error: reasonOf(cause) });
			}
		}
		const failed = working
			.filter((item) => item.stage.startsWith("failed-"))
			.map((item) => ({ id: item.file.name, reason: item.error ?? "不明なエラー" }));
		setFailures(failed);
		await recordOperation({
			kind: "photo-upload",
			status: failed.length ? "partial" : "complete",
			targetIds: created,
			failures: failed,
			metadata: { albumId: album.id, requested: initial.length },
		}).catch(() => undefined);
		setMessage(failed.length
			? `${created.length}点を追加・${failed.length}点が失敗（この画面で失敗分だけ再試行できます）`
			: `${created.length}点を下書きへ追加しました`);
		setBusy(false);
	};

	const orderedVisibleIds = visible.map((photo) => photo.id);
	const uploadSettled = uploadQueue.filter((item) => isUploadQueueSettled(item.stage)).length;
	const hasRetryableUpload = uploadQueue.some((item) => isUploadQueueRetryable(item.stage));

	return <section data-organizer-ready={albumReady ? "true" : "false"} className="photo-tools-workspace" data-photo-tools-busy={busy ? "true" : undefined}>
		<header className="photo-tools-workspace__header">
			<div><span className="photo-tools-eyebrow">選択中のアルバム</span><h1>{labelOf(album)}</h1><p>{albumReady ? `${albumCount?.total ?? albumPhotos.length}点` : "写真を読込中"}・未公開の変更 {Math.max(albumCount?.pending ?? 0, pendingIds.size) + (albumDraftDirty || hasPendingChanges(album) ? 1 : 0)}件</p></div>
			<div className="photo-tools-actions">
				<button className="photo-tools-button photo-tools-button--primary" disabled={operationLocked || !workspacePending || !albumDraft.title.trim()} onClick={publishWorkspace}>{busy ? "処理中…" : album.status === "published" ? workspacePending ? "変更を公開" : "公開済み" : "アルバムを公開"}</button>
				<a className="photo-tools-button" href={albumEditHref(album.id)} onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>詳細編集</a>
				{live && <a className="photo-tools-button" href={live} target="_blank" rel="noreferrer" onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>Album公開ページ</a>}
			</div>
		</header>

		<details className="photo-tools-album-settings" open={album.status !== "published"} data-photo-tools-dirty={albumDraftDirty ? "true" : undefined}>
			<summary>アルバム名と説明</summary>
			<div><label>アルバム名<input value={albumDraft.title} disabled={busy} onChange={(event) => setAlbumDraft({ ...albumDraft, title: event.target.value })} /></label><label>説明<textarea value={albumDraft.description} disabled={busy} onChange={(event) => setAlbumDraft({ ...albumDraft, description: event.target.value })} /></label></div>
			<button className="photo-tools-button" disabled={busy || !albumDraftDirty || !albumDraft.title.trim()} onClick={saveAlbumDraft}>アルバム情報を下書き保存</button>
		</details>
		<div className="photo-tools-mobile-subtabs" role="tablist" aria-label="写真整理の表示">
			<button type="button" role="tab" aria-selected={mobilePane === "photos"} onClick={() => setMobilePane("photos")}>写真</button>
			<button type="button" role="tab" aria-selected={mobilePane === "info"} disabled={!inspectorPhoto && checkedPhotos.length < 2} onClick={() => setMobilePane("info")}>{checkedPhotos.length > 1 ? "一括操作" : "写真情報"}</button>
		</div>

		<div className="photo-tools-toolbar">
			<label>写真を検索<input type="search" placeholder="タイトル・キャプション・ファイル名" value={search} disabled={busy || !albumReady} onChange={(event) => setSearch(event.target.value)} /></label>
			<label>要確認<select value={filter} disabled={busy || !albumReady} onChange={(event) => setFilter(event.target.value as "" | ReviewFlag)}><option value="">すべて</option>{Object.entries(FLAG_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
			<label className="photo-tools-button photo-tools-upload">写真を追加<input type="file" accept={ACCEPTED_IMAGE_INPUT} multiple hidden disabled={operationLocked} onChange={(event) => {
				const requestedFiles = [...(event.target.files ?? [])];
				if (!requestedFiles.length) return;
				const queue = createUploadQueue<File, PhotoMediaItem>(requestedFiles, {
					batchId: String(Date.now()),
					startPosition: Math.max(albumCount?.maxPosition ?? 0, ...albumPhotos.map((photo) => Number(dataOf(photo).position) || 0)),
					acceptedTypes: ACCEPTED_IMAGE_TYPES,
					maxBytes: MAX_UPLOAD_BYTES,
					maxFiles: 20,
				});
				event.currentTarget.value = "";
				setUploadQueue(queue);
				void executeUploadQueue(queue);
			}} /></label>
			<button className="photo-tools-button" disabled={operationLocked || visible.length === 0} onClick={() => { if (canChangeOrganizerContext()) setChecked(new Set(visible.map((photo) => photo.id))); }}>表示中を全選択</button>
			<button className="photo-tools-button" disabled={operationLocked || (albumCount?.total ?? albumPhotos.length) < 2} onClick={async () => { setBusy(true); try { await persistOrder((await albumPhotosForOperation(album.id)).sort((left, right) => compareCapturedAt(
				dataOf(left).captured_at,
				dataOf(right).captured_at,
				Number(dataOf(left).position) || 0,
				Number(dataOf(right).position) || 0,
				left.id,
				right.id,
			))); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>撮影日順</button>
			{undoOrder && <button className="photo-tools-button" disabled={operationLocked} onClick={() => restore(undoOrder, "order")}>並び順を戻す</button>}
			{undoMove && <button className="photo-tools-button" disabled={operationLocked} onClick={() => restore(undoMove, "move")}>移動を戻す</button>}
		</div>
		{uploadQueue.length > 0 && <section className="photo-tools-upload-queue" aria-label="写真追加の進捗" aria-live="polite">
			<header>
				<div><strong>写真追加</strong><span>{uploadSettled}/{uploadQueue.length}件 完了</span></div>
				<button type="button" className="photo-tools-button" disabled={busy || !hasRetryableUpload} onClick={() => void executeUploadQueue(retryFailedUploadQueue(uploadQueue))}>失敗分だけ再試行</button>
			</header>
			<progress aria-label="写真追加の完了件数" max={uploadQueue.length} value={uploadSettled}>{uploadSettled}/{uploadQueue.length}</progress>
			<ul>{uploadQueue.map((item) => <li key={item.id} data-stage={item.stage}>
				<span title={item.file.name}>{item.file.name}</span>
				<strong>{UPLOAD_STAGE_LABELS[item.stage]}</strong>
				{item.error && <small>{item.error}</small>}
			</li>)}</ul>
			<p className="photo-tools-muted">失敗分のファイルは、この画面を開いている間だけ再試行用に保持します。画面を再読み込みした場合は選び直してください。追加した写真は下書きのままです。</p>
		</section>}
		{!albumReady && <p className="photo-tools-status" role="status">写真を読み込んでいます…</p>}
		{photoDraftDirty && <p className="photo-tools-status" role="status">写真情報に未保存の変更があります。下書き保存すると他の操作を再開できます。</p>}

		{message && <p className="photo-tools-status" role="status">{message}</p>}
		<ErrorBox error={error} />
		{failures.length > 0 && <div className="photo-tools-alert photo-tools-alert--error"><strong>{failures.length}件を処理できませんでした。</strong><ul>{failures.map((failure) => <li key={`${failure.id}:${failure.reason}`}><code>{failure.id}</code>: {failure.reason}</li>)}</ul></div>}

		<div className={`photo-tools-content is-mobile-${mobilePane}`}>
			<section className="photo-tools-grid-area" aria-label="アルバムの写真">
				{firstOffset > 0 && <button className="photo-tools-button" disabled={operationLocked} onClick={onFirstPage}>先頭から表示</button>}
				{nextOffset !== null && <button className="photo-tools-button" disabled={operationLocked} onClick={onLoadMore}>さらに50件表示</button>}
				<p className="photo-tools-muted">表示中 {visible.length} / {resultTotal}点{checked.size ? `・${checked.size}点を選択中` : ""}</p>
				{visible.length ? <div className="photo-tools-grid">{visible.map((photo) => {
					const index = albumPhotos.findIndex((item) => item.id === photo.id);
					const flags = photoReviewFlags(dataOf(photo), { status: photo.status });
					const isCover = mediaUrl(dataOf(album).cover_image) === mediaUrl(dataOf(photo).image);
					return <article key={photo.id} className={`photo-tools-card ${inspectorPhoto?.id === photo.id ? "is-active" : ""} ${checked.has(photo.id) ? "is-checked" : ""}`} draggable={!operationLocked && !search && !filter} onDragStart={() => setDragId(photo.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
						if (!dragId || dragId === photo.id || search || filter) return;
						const next = [...albumPhotos]; const from = next.findIndex((item) => item.id === dragId); const [moved] = next.splice(from, 1); next.splice(index, 0, moved); setDragId(null); void persistOrder(next);
					}} onKeyDown={(event) => {
						if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
						event.preventDefault(); moveAt(index, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
					}} tabIndex={0}>
						<label className="photo-tools-check"><input type="checkbox" checked={checked.has(photo.id)} disabled={busy || !albumReady} onChange={() => toggleChecked(photo.id)} /><span>選択</span></label>
						<button className="photo-tools-card__select" type="button" disabled={busy} onClick={() => { if (!canChangeOrganizerContext()) return; setChecked(new Set()); setSelectedId(photo.id); setMobilePane("info"); }}><Preview value={dataOf(photo).image} /><strong>{labelOf(photo)}</strong><small>{textValue(dataOf(photo).captured_at).slice(0, 10) || "撮影日なし"}</small></button>
						<div className="photo-tools-badges">{isCover && <Badge tone="ok">カバー</Badge>}<Badge tone={hasPendingChanges(photo) ? "warn" : "ok"}>{statusLabel(photo)}</Badge>{flags.filter((flag) => flag !== "unpublished").map((flag) => <Badge key={flag} tone={flag === "has-location" || flag === "location-unreviewed" ? "danger" : "warn"}>{FLAG_LABELS[flag]}</Badge>)}</div>
						<div className="photo-tools-card__actions"><button disabled={operationLocked || index === 0} onClick={() => moveAt(index, -1)} aria-label="前へ移動">←</button><button disabled={operationLocked || index === albumPhotos.length - 1} onClick={() => moveAt(index, 1)} aria-label="後ろへ移動">→</button><button disabled={operationLocked || isCover} onClick={async () => {
							setBusy(true); setError(null); try {
								if (!album._rev) throw new Error("アルバムの編集情報を再読込してください。");
								const result = await updateDraft("albums", album.id, album._rev, { cover_image: dataOf(photo).image }); onAlbumUpdated(result.item); setMessage("カバー写真を下書き保存しました");
							} catch (cause) { setError(new Error(reasonOf(cause))); } finally { setBusy(false); }
						}}>カバー</button></div>
					</article>;
				})}</div> : <p className="photo-tools-empty">{!albumReady ? "このアルバムの写真を読み込んでいます…" : "この条件に合う写真はありません。"}</p>}
			</section>
			{checkedPhotos.length > 1
				? <BulkInspector selected={checkedPhotos} albums={albums} busy={busy} onApply={applyBulk} onMove={moveSelected} onPublish={publishMany} onClear={() => setChecked(new Set())} />
				: inspectorPhoto && dataOf(inspectorPhoto).album === album.id && inspectorReady
						? <PhotoInspector photo={inspectorPhoto} albums={albums} busy={busy} onSave={savePhoto} onPublish={publishMany} onDirtyChange={setPhotoDraftDirty} previousId={adjacentPhotoId(orderedVisibleIds, inspectorPhoto.id, -1)} nextId={adjacentPhotoId(orderedVisibleIds, inspectorPhoto.id, 1)} onNavigate={(photoId) => { setChecked(new Set()); setSelectedId(photoId); setMobilePane("info"); }} />
					: <aside className="photo-tools-inspector">{photoHydration?.identity === inspectorIdentity && photoHydration.status === "error"
						? <><ErrorBox error={photoHydration.error} /><button type="button" className="photo-tools-button" onClick={() => setPhotoHydrationRetry((value) => value + 1)}>再試行</button></>
						: <p className="photo-tools-muted" role={inspectorPhoto ? "status" : undefined}>{inspectorPhoto ? "写真の下書きを読み込んでいます…" : "写真を選ぶと、ここで情報を編集できます。"}</p>}</aside>}
		</div>
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
	const [mobilePane, setMobilePane] = useState<"albums" | "workspace">("workspace");
	const [workspaceBusy, setWorkspaceBusy] = useState(false);
	const [photoIndexLoading, setPhotoIndexLoading] = useState(true);
	const [readyAlbumId, setReadyAlbumId] = useState("");
	const [albumHydration, setAlbumHydration] = useState<{ identity: string; status: "loading" | "ready" | "error"; error?: unknown } | null>(null);
	const [albumHydrationRetry, setAlbumHydrationRetry] = useState(0);
	const albumHydrationSequence = useRef(0);

	useEffect(() => {
		allContent("albums", { orderBy: "captured_from", order: "desc" }).then((albumItems) => {
			setAlbums(albumItems);
			const requested = new URLSearchParams(window.location.search).get("album");
			setSelectedId(requested && albumItems.some((album) => album.id === requested) ? requested : albumItems[0]?.id ?? "");
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
				setPhotos(current => query.offset ? mergeEditableItems(current, page.items) : page.items);
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
	const visibleAlbums = useMemo(() => {
		const needle = albumSearch.trim().toLocaleLowerCase("ja");
		return needle ? albums.filter(album => labelOf(album).toLocaleLowerCase("ja").includes(needle)) : albums;
	}, [albums, albumSearch]);

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

	return <main className="photo-tools-shell">
		<header className="photo-tools-page-header"><div><span className="photo-tools-eyebrow">EmDash 写真管理</span><h1>写真を整理</h1><p>アルバムを選び、写真の追加・編集・並べ替え・公開までを進めます。記事や固定ページはEmDashの各画面で編集してください。</p></div><a className="photo-tools-button" href={`${CORE_ROOT}/content/albums`}>Albums一覧</a></header>
		<ErrorBox error={error} />
		{!loading && <div className="photo-tools-mobile-tabs" role="tablist" aria-label="写真管理の表示">
			<button type="button" role="tab" aria-selected={mobilePane === "albums"} onClick={() => setMobilePane("albums")}>アルバム</button>
			<button type="button" role="tab" aria-selected={mobilePane === "workspace"} disabled={!selected} onClick={() => setMobilePane("workspace")}>写真</button>
		</div>}
		{loading ? <p className="photo-tools-muted" role="status">アルバムと写真を読み込んでいます…</p> : <div className={`photo-tools-organizer is-mobile-${mobilePane}`}>
			<aside className="photo-tools-album-rail" aria-label="アルバム">
				<div className="photo-tools-album-rail__header"><h2>アルバム</h2><button className="photo-tools-button" disabled={workspaceBusy} onClick={() => setShowNew((value) => !value)}>新規</button></div>
				{showNew && <div className="photo-tools-create"><label>アルバム名<input autoFocus value={newTitle} disabled={creating || workspaceBusy} onChange={(event) => setNewTitle(event.target.value)} /></label><button className="photo-tools-button photo-tools-button--primary" disabled={creating || workspaceBusy || !newTitle.trim()} onClick={async () => {
					if (!canChangeOrganizerContext()) return; setCreating(true); setError(null); try { const result = await createAlbumDraft(newTitle.trim()); setAlbums((current) => [result.item, ...current]); setReadyAlbumId(""); setSelectedId(result.item.id); setMobilePane("workspace"); setNewTitle(""); setShowNew(false); } catch (cause) { setError(cause); } finally { setCreating(false); }
				}}>下書きを作る</button></div>}
				<label>アルバムを検索<input type="search" value={albumSearch} onChange={(event) => setAlbumSearch(event.target.value)} /></label>
				{photoIndexLoading && <p className="photo-tools-index-status" role="status">写真件数を読み込み中…</p>}
				<div className="photo-tools-album-list">{visibleAlbums.map((album) => {
					const count = counts.find(count => count.album === album.id) ?? { total: 0, pending: 0 };
					return <button key={album.id} disabled={workspaceBusy} className={selectedId === album.id ? "is-active" : ""} onClick={() => { if (!canChangeOrganizerContext()) return; if (album.id !== selectedId) { setReadyAlbumId(""); setQuery({q:"",filter:"",offset:0,photo:""}); setPhotos([]); setSelectedId(album.id); } setMobilePane("workspace"); }}><Preview value={dataOf(album).cover_image} size={72} /><span><strong>{labelOf(album)}</strong><small>{photoIndexLoading ? "件数を読込中" : `${count.total}点${count.pending ? `・変更 ${count.pending}` : ""}`}</small><Badge tone={hasPendingChanges(album) ? "warn" : "ok"}>{statusLabel(album)}</Badge></span></button>;
				})}</div>
			</aside>
			{selected && selectedReady
				? <AlbumOrganizer key={selected.id} album={selected} albums={albums} allPhotos={photos} onAlbumUpdated={(updated) => setAlbums((current) => mergeEditableItems(current, [updated]))} onPhotoUpdated={(updated) => setPhotos((current) => current.some(photo => photo.id === updated.id) ? mergeEditableItems(current, [updated]) : current)} onPhotoAdded={(created) => setPhotos((current) => mergeEditableItems(current, [created]))} onBusyChange={setWorkspaceBusy} albumReady={readyAlbumId === selected.id} firstOffset={firstOffset} onFirstPage={() => setQuery(current => ({...current,offset:0,photo:""}))} onQuery={changeQuery} onRefresh={() => setQuery(current => ({...current,offset:0}))} nextOffset={nextOffset} resultTotal={resultTotal} albumCount={counts.find(count=>count.album===selected.id)} onLoadMore={() => { if (canChangeOrganizerContext() && nextOffset !== null) setQuery(current=>({...current,offset:nextOffset})); }} />
				: selected && albumHydration?.identity === selectedIdentity && albumHydration.status === "error"
					? <section className="photo-tools-workspace"><ErrorBox error={albumHydration.error} /><button type="button" className="photo-tools-button" onClick={() => setAlbumHydrationRetry((value) => value + 1)}>再試行</button></section>
					: selected
						? <p className="photo-tools-empty" role="status">アルバムの下書きを読み込んでいます…</p>
						: <p className="photo-tools-empty">アルバムがありません。「新規」から作成してください。</p>}
		</div>}
	</main>;
}

function ThumbnailColumn({ item }: ContentListColumnCellContext) {
	return <Preview value={dataOf(item).image} size={56} />;
}

function PhotoLabelColumn({ item }: ContentListColumnCellContext) {
	const albumId = textValue(dataOf(item).album);
	return <span><a href={albumId ? organizerHref(albumId, item.id) : photoEditHref(item.id)}>{labelOf(item)}</a><small className="photo-tools-column-date">{textValue((dataOf(item).image as Record<string, unknown> | undefined)?.filename)}</small></span>;
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
	useEffect(() => { allContent("photos", { fieldFilters: { album: entry.id }, orderBy: "position", order: "asc" }).then(setPhotos).catch(setError); }, [entry.id]);
	const published = photos.filter((photo) => !hasPendingChanges(photo)).length;
	const live = publicHref(entry, "album");
	return <div className="photo-tools-panel"><p><strong>{photos.length}点</strong>（公開済み {published}・未公開の変更 {photos.length - published}）</p><div className="photo-tools-panel-grid">{photos.slice(0, 24).map((photo) => <a key={photo.id} href={organizerHref(entry.id, photo.id)} title={`${labelOf(photo)}を整理`}><Preview value={dataOf(photo).image} size={72} /></a>)}</div>{photos.length > 24 && <p className="photo-tools-muted">ほか {photos.length - 24}点</p>}<div className="photo-tools-panel-actions"><a className="photo-tools-button photo-tools-button--primary" href={organizerHref(entry.id)}>写真を整理</a>{live && <a className="photo-tools-button" href={live} target="_blank" rel="noreferrer">Album公開ページ</a>}</div><ErrorBox error={error} /></div>;
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
	{ id: "album-photos", title: "アルバムの写真", collections: ["albums"], order: -20, component: AlbumPhotoPanel },
	{ id: "photo-organizer", title: "アルバムで整理", collections: ["photos"], order: -20, component: PhotoOrganizerPanel },
];

export const fields = { "related-album-hidden": HiddenRelatedAlbumField };
export const pages = { "/organize": PhotoOrganizerPage };
