import React, { useEffect, useMemo, useState } from "react";
import type {
	ContentEditorPanelContext,
	ContentEditorPanelExtension,
	ContentItem,
	ContentListColumnCellContext,
	ContentListColumnExtension,
} from "@emdash-cms/admin";
import {
	allContent,
	createAlbumDraft,
	getContent,
	publishDraft,
	recordOperation,
	PhotoToolsApiError,
	updateDraft,
	uploadPhoto,
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
import "./studio.css";

const CORE_ROOT = "/_emdash/admin";
const ORGANIZER_ROOT = "/_emdash/admin/plugins/yohaku-photo-tools/organize";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const ACCEPTED_IMAGE_INPUT = [...ACCEPTED_IMAGE_TYPES].join(",");

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

function mergeContentItems(current: ContentItem[], incoming: readonly ContentItem[]): ContentItem[] {
	const merged = new Map(current.map((item) => [item.id, item]));
	for (const item of incoming) {
		const existing = merged.get(item.id);
		if (!existing || String(item.updatedAt ?? "") > String(existing.updatedAt ?? "")) merged.set(item.id, item);
	}
	return [...merged.values()];
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
}: {
	photo: ContentItem;
	albums: ContentItem[];
	busy: boolean;
	onSave: (photo: ContentItem, patch: Record<string, unknown>) => Promise<void>;
	onPublish: (ids: string[]) => Promise<void>;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const [draft, setDraft] = useState(() => ({
		title: textValue(dataOf(photo).title),
		caption: textValue(dataOf(photo).caption),
		alt: textValue(dataOf(photo).alt),
		captured_at: textValue(dataOf(photo).captured_at).slice(0, 16),
		album: textValue(dataOf(photo).album),
	}));
	useEffect(() => setDraft({
		title: textValue(dataOf(photo).title),
		caption: textValue(dataOf(photo).caption),
		alt: textValue(dataOf(photo).alt),
		captured_at: textValue(dataOf(photo).captured_at).slice(0, 16),
		album: textValue(dataOf(photo).album),
	}), [photo.id, photo.updatedAt]);
	const dirty =
		draft.title !== textValue(dataOf(photo).title) ||
		draft.caption !== textValue(dataOf(photo).caption) ||
		draft.alt !== textValue(dataOf(photo).alt) ||
		draft.captured_at !== textValue(dataOf(photo).captured_at).slice(0, 16) ||
		draft.album !== textValue(dataOf(photo).album);
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
	const live = publicHref(photo, "photo");
	const locationUnreviewed = needsLocationReview(dataOf(photo));
	return <aside className="photo-tools-inspector" aria-label="写真情報" data-photo-tools-dirty={dirty ? "true" : undefined}>
		<header><div><span className="photo-tools-eyebrow">写真情報</span><h2>{labelOf(photo)}</h2></div><Badge tone={dirty || hasPendingChanges(photo) ? "warn" : "ok"}>{dirty ? "未保存" : statusLabel(photo)}</Badge></header>
		<Preview value={dataOf(photo).image} size={480} />
		<label>タイトル<input value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
		<label>キャプション<textarea value={draft.caption} disabled={busy} placeholder="キャプションを追加" onChange={(event) => setDraft({ ...draft, caption: event.target.value })} /></label>
		<label>代替テキスト<input value={draft.alt} disabled={busy} onChange={(event) => setDraft({ ...draft, alt: event.target.value })} /></label>
		<label>撮影日<input type="datetime-local" value={draft.captured_at} disabled={busy} onChange={(event) => setDraft({ ...draft, captured_at: event.target.value })} /></label>
		<label>アルバム<select value={draft.album} disabled={busy} onChange={(event) => setDraft({ ...draft, album: event.target.value })}>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
		<div className="photo-tools-actions">
			<button className="photo-tools-button photo-tools-button--primary" disabled={busy || !dirty || !draft.title.trim() || !draft.alt.trim()} onClick={() => onSave(photo, draft)}>下書き保存</button>
			<button className="photo-tools-button" disabled={busy || dirty || locationUnreviewed || !hasPendingChanges(photo)} onClick={() => onPublish([photo.id])}>この写真だけ公開</button>
			<a className="photo-tools-button" href={photoEditHref(photo.id)} onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>詳細編集</a>
			{live && <a className="photo-tools-button" href={live} target="_blank" rel="noreferrer" onClick={(event) => { if (!canChangeOrganizerContext()) event.preventDefault(); }}>Photo公開ページ</a>}
		</div>
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
}: {
	album: ContentItem;
	albums: ContentItem[];
	allPhotos: ContentItem[];
	onAlbumUpdated: (item: ContentItem) => void;
	onPhotoUpdated: (item: ContentItem) => void;
	onPhotoAdded: (item: ContentItem) => void;
	onBusyChange: (busy: boolean) => void;
	albumReady: boolean;
}) {
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
	const [albumDraft, setAlbumDraft] = useState({
		title: textValue(dataOf(album).title),
		description: textValue(dataOf(album).description),
	});

	useEffect(() => {
		setSelectedId(null);
		setChecked(new Set());
		setTouchedIds(new Set());
		setUndoOrder(null);
		setUndoMove(null);
		setMobilePane("photos");
		setPhotoDraftDirty(false);
		setAlbumDraft({ title: textValue(dataOf(album).title), description: textValue(dataOf(album).description) });
		setMessage(""); setError(null); setFailures([]);
	}, [album.id]);
	useEffect(() => {
		if (selectedId && albumPhotos.some((photo) => photo.id === selectedId)) return;
		const requested = new URLSearchParams(window.location.search).get("photo");
		setSelectedId(requested && albumPhotos.some((photo) => photo.id === requested) ? requested : albumPhotos[0]?.id ?? null);
	}, [album.id, albumPhotos, selectedId]);

	const visible = useMemo(() => albumPhotos.filter((photo) => {
		const data = dataOf(photo);
		const needle = search.trim().toLocaleLowerCase("ja");
		if (needle && ![data.title, data.caption, (data.image as Record<string, unknown> | undefined)?.filename]
			.some((value) => textValue(value).toLocaleLowerCase("ja").includes(needle))) return false;
		return !filter || photoReviewFlags(data, { status: photo.status }).includes(filter);
	}), [albumPhotos, search, filter]);
	const selectedPhoto = allPhotos.find((photo) => photo.id === selectedId) ?? null;
	const checkedPhotos = allPhotos.filter((photo) => checked.has(photo.id));
	const inspectorPhoto = checkedPhotos.length === 1 ? checkedPhotos[0] : selectedPhoto;
	const albumDraftDirty = albumDraft.title.trim() !== textValue(dataOf(album).title) || albumDraft.description.trim() !== textValue(dataOf(album).description);
	const pendingIds = new Set([...albumPhotos.filter(hasPendingChanges).map((photo) => photo.id), ...touchedIds]);
	const workspacePending = albumDraftDirty || hasPendingChanges(album) || pendingIds.size > 0;
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
		if (!albumDraftDirty || !albumDraft.title.trim()) return;
		setBusy(true); setError(null); setFailures([]); setMessage("アルバム情報を保存中…");
		try {
			const current = await getContent("albums", album.id);
			const result = await updateDraft("albums", album.id, current._rev, { title: albumDraft.title.trim(), description: albumDraft.description.trim() });
			onAlbumUpdated(result.item); setMessage("アルバム情報を下書き保存しました");
		} catch (cause) { setError(new Error(reasonOf(cause))); setMessage(""); }
		finally { setBusy(false); }
	};

	const savePhoto = async (photo: ContentItem, patch: Record<string, unknown>) => {
		setBusy(true); setError(null); setMessage("保存中…"); setFailures([]);
		try {
			let normalized = patch;
			const targetAlbum = textValue(patch.album);
			if (targetAlbum && targetAlbum !== dataOf(photo).album) {
				const targetPhotos = await allContent("photos", { fieldFilters: { album: targetAlbum }, orderBy: "position", order: "asc" });
				normalized = { ...patch, position: Math.max(0, ...targetPhotos.map((item) => Number(dataOf(item).position) || 0)) + 1024 };
				setUndoMove([{ id: photo.id, album: textValue(dataOf(photo).album), position: Number(dataOf(photo).position) || 0 }]);
			}
			const current = await getContent("photos", photo.id);
			const result = await updateDraft("photos", photo.id, current._rev, normalized);
			onPhotoUpdated(result.item); touch(photo.id); setMessage("写真の下書きを保存しました");
			if (targetAlbum && targetAlbum !== album.id) {
				setSelectedId(null);
				setChecked((current) => {
					const next = new Set(current);
					next.delete(photo.id);
					return next;
				});
			}
		} catch (cause) { setError(new Error(reasonOf(cause))); setMessage(""); }
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
		if (photoDraftDirty || !albumReady) return;
		setBusy(true); setError(null); setFailures([]); setMessage("並び順を保存中…");
		const positions = sparsePositions(next.length);
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
		setMessage(failed.length ? `並び順を完了できなかったため、保存済みの変更を元へ戻しました（${failed.length}件を確認してください）` : "並び順を下書き保存しました"); setBusy(false);
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
		if (albumDraftDirty) {
			try { const current = await getContent("albums", album.id); const result = await updateDraft("albums", album.id, current._rev, { title: albumDraft.title.trim(), description: albumDraft.description.trim() }); onAlbumUpdated(result.item); }
			catch (cause) { failed.push({ id: album.id, reason: reasonOf(cause) }); albumSaveFailed = true; }
		}
			if (!albumSaveFailed) {
				for (const id of pendingIds) {
					const photo = allPhotos.find((item) => item.id === id);
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
		await recordOperation({ kind: "album-publish", status: failed.length ? "partial" : "complete", targetIds: [album.id, ...pendingIds], failures: failed, metadata: { albumId: album.id, publishedPhotos } }).catch(() => undefined);
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

	return <section className="photo-tools-workspace" data-photo-tools-busy={busy ? "true" : undefined}>
		<header className="photo-tools-workspace__header">
			<div><span className="photo-tools-eyebrow">選択中のアルバム</span><h1>{labelOf(album)}</h1><p>{albumReady ? `${albumPhotos.length}点` : "写真を読込中"}・未公開の変更 {pendingIds.size + (albumDraftDirty || hasPendingChanges(album) ? 1 : 0)}件</p></div>
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
			<label className="photo-tools-button photo-tools-upload">写真を追加<input type="file" accept={ACCEPTED_IMAGE_INPUT} multiple hidden disabled={operationLocked} onChange={async (event) => {
				const requestedFiles = [...(event.target.files ?? [])];
				const files = requestedFiles.slice(0, 20);
				if (!files.length) return;
				setBusy(true); setError(null); setFailures([]); setMessage(`${files.length}点を追加中…`);
				let position = Math.max(0, ...albumPhotos.map((photo) => Number(dataOf(photo).position) || 0));
				const failed: Failure[] = []; const created: string[] = [];
				for (const file of files) {
					if (!ACCEPTED_IMAGE_TYPES.has(file.type)) { failed.push({ id: file.name, reason: "JPEG、PNG、WebP、GIF、AVIFだけ追加できます" }); continue; }
					if (file.size > MAX_UPLOAD_BYTES) { failed.push({ id: file.name, reason: "1枚50MBの上限を超えています" }); continue; }
					try { position += 1024; const result = await uploadPhoto(file, album.id, position); onPhotoAdded(result.item); touch(result.item.id); created.push(result.item.id); }
					catch (cause) { failed.push({ id: file.name, reason: reasonOf(cause) }); }
				}
				for (const file of requestedFiles.slice(20)) failed.push({ id: file.name, reason: "一度に追加できるのは20枚までです" });
				setFailures(failed); await recordOperation({ kind: "photo-upload", status: failed.length ? "partial" : "complete", targetIds: created, failures: failed, metadata: { albumId: album.id, requested: files.length } }).catch(() => undefined);
				setMessage(failed.length ? `${created.length}点を追加・${failed.length}点が失敗` : `${created.length}点を下書きへ追加しました`); setBusy(false); event.target.value = "";
			}} /></label>
			<button className="photo-tools-button" disabled={operationLocked || visible.length === 0} onClick={() => { if (canChangeOrganizerContext()) setChecked(new Set(visible.map((photo) => photo.id))); }}>表示中を全選択</button>
			<button className="photo-tools-button" disabled={operationLocked || albumPhotos.length < 2} onClick={() => persistOrder([...albumPhotos].sort((left, right) => compareCapturedAt(
				dataOf(left).captured_at,
				dataOf(right).captured_at,
				Number(dataOf(left).position) || 0,
				Number(dataOf(right).position) || 0,
				left.id,
				right.id,
			)))}>撮影日順</button>
			{undoOrder && <button className="photo-tools-button" disabled={operationLocked} onClick={() => restore(undoOrder, "order")}>並び順を戻す</button>}
			{undoMove && <button className="photo-tools-button" disabled={operationLocked} onClick={() => restore(undoMove, "move")}>移動を戻す</button>}
		</div>
		{!albumReady && <p className="photo-tools-status" role="status">このアルバムの写真をすべて読み込んでいます。完了すると編集できます。</p>}
		{photoDraftDirty && <p className="photo-tools-status" role="status">写真情報に未保存の変更があります。下書き保存すると他の操作を再開できます。</p>}

		{message && <p className="photo-tools-status" role="status">{message}</p>}
		<ErrorBox error={error} />
		{failures.length > 0 && <div className="photo-tools-alert photo-tools-alert--error"><strong>{failures.length}件を処理できませんでした。</strong><ul>{failures.map((failure) => <li key={`${failure.id}:${failure.reason}`}><code>{failure.id}</code>: {failure.reason}</li>)}</ul></div>}

		<div className={`photo-tools-content is-mobile-${mobilePane}`}>
			<section className="photo-tools-grid-area" aria-label="アルバムの写真">
				<p className="photo-tools-muted">表示中 {visible.length}点{checked.size ? `・${checked.size}点を選択中` : ""}</p>
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
							setBusy(true); setError(null); try { const current = await getContent("albums", album.id); const result = await updateDraft("albums", album.id, current._rev, { cover_image: dataOf(photo).image }); onAlbumUpdated(result.item); setMessage("カバー写真を下書き保存しました"); } catch (cause) { setError(new Error(reasonOf(cause))); } finally { setBusy(false); }
						}}>カバー</button></div>
					</article>;
				})}</div> : <p className="photo-tools-empty">{!albumReady ? "このアルバムの写真を読み込んでいます…" : "この条件に合う写真はありません。"}</p>}
			</section>
			{checkedPhotos.length > 1
				? <BulkInspector selected={checkedPhotos} albums={albums} busy={busy} onApply={applyBulk} onMove={moveSelected} onPublish={publishMany} onClear={() => setChecked(new Set())} />
				: inspectorPhoto && dataOf(inspectorPhoto).album === album.id
					? <PhotoInspector photo={inspectorPhoto} albums={albums} busy={busy} onSave={savePhoto} onPublish={publishMany} onDirtyChange={setPhotoDraftDirty} />
					: <aside className="photo-tools-inspector"><p className="photo-tools-muted">写真を選ぶと、ここで情報を編集できます。</p></aside>}
		</div>
	</section>;
}

export function PhotoOrganizerPage() {
	const [albums, setAlbums] = useState<ContentItem[]>([]);
	const [photos, setPhotos] = useState<ContentItem[]>([]);
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

	useEffect(() => {
		allContent("albums", { orderBy: "captured_from", order: "desc" }).then((albumItems) => {
			setAlbums(albumItems);
			const requested = new URLSearchParams(window.location.search).get("album");
			setSelectedId(requested && albumItems.some((album) => album.id === requested) ? requested : albumItems[0]?.id ?? "");
		}).catch(setError).finally(() => setLoading(false));
		allContent("photos", { orderBy: "captured_at", order: "desc" }, (items) => {
			setPhotos((current) => mergeContentItems(current, items));
		}).then((items) => setPhotos((current) => mergeContentItems(current, items)))
			.catch(setError)
			.finally(() => setPhotoIndexLoading(false));
	}, []);

	useEffect(() => {
		if (!selectedId) return;
		let cancelled = false;
		setReadyAlbumId("");
		allContent("photos", { fieldFilters: { album: selectedId }, orderBy: "position", order: "asc" })
			.then((items) => {
				if (cancelled) return;
				setPhotos((current) => mergeContentItems(current, items));
				setReadyAlbumId(selectedId);
			})
			.catch((cause) => { if (!cancelled) setError(cause); });
		return () => { cancelled = true; };
	}, [selectedId]);

	const visibleAlbums = useMemo(() => {
		const needle = albumSearch.trim().toLocaleLowerCase("ja");
		return needle ? albums.filter((album) => labelOf(album).toLocaleLowerCase("ja").includes(needle)) : albums;
	}, [albums, albumSearch]);
	const counts = useMemo(() => {
		const result = new Map<string, { total: number; pending: number }>();
		for (const photo of photos) {
			const albumId = textValue(dataOf(photo).album); if (!albumId) continue;
			const current = result.get(albumId) ?? { total: 0, pending: 0 };
			current.total += 1; if (hasPendingChanges(photo)) current.pending += 1; result.set(albumId, current);
		}
		return result;
	}, [photos]);
	const selected = albums.find((album) => album.id === selectedId) ?? null;

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
					const count = counts.get(album.id) ?? { total: 0, pending: 0 };
					return <button key={album.id} disabled={workspaceBusy} className={selectedId === album.id ? "is-active" : ""} onClick={() => { if (!canChangeOrganizerContext()) return; if (album.id !== selectedId) { setReadyAlbumId(""); setSelectedId(album.id); } setMobilePane("workspace"); }}><Preview value={dataOf(album).cover_image} size={72} /><span><strong>{labelOf(album)}</strong><small>{photoIndexLoading ? "件数を読込中" : `${count.total}点${count.pending ? `・変更 ${count.pending}` : ""}`}</small><Badge tone={hasPendingChanges(album) ? "warn" : "ok"}>{statusLabel(album)}</Badge></span></button>;
				})}</div>
			</aside>
			{selected ? <AlbumOrganizer key={selected.id} album={selected} albums={albums} allPhotos={photos} onAlbumUpdated={(updated) => setAlbums((current) => current.map((album) => album.id === updated.id ? updated : album))} onPhotoUpdated={(updated) => setPhotos((current) => mergeContentItems(current, [updated]))} onPhotoAdded={(created) => setPhotos((current) => mergeContentItems(current, [created]))} onBusyChange={setWorkspaceBusy} albumReady={readyAlbumId === selected.id} /> : <p className="photo-tools-empty">アルバムがありません。「新規」から作成してください。</p>}
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

export const contentListColumns: readonly ContentListColumnExtension[] = [
	{ id: "photo-thumbnail", label: "写真", collections: ["photos"], order: -30, cell: ThumbnailColumn },
	{ id: "photo-label", label: "タイトル／キャプション", collections: ["photos"], order: -25, cell: PhotoLabelColumn },
	{ id: "photo-album", label: "アルバム", collections: ["photos"], order: -20, cell: AlbumColumn },
	{ id: "photo-review", label: "要確認", collections: ["photos"], order: -10, cell: ReviewColumn },
	{ id: "photo-state", label: "状態／更新", collections: ["photos"], order: -5, cell: PhotoStateColumn },
];

export const contentEditorPanels: readonly ContentEditorPanelExtension[] = [
	{ id: "album-photos", title: "アルバムの写真", collections: ["albums"], order: -20, component: AlbumPhotoPanel },
	{ id: "photo-organizer", title: "アルバムで整理", collections: ["photos"], order: -20, component: PhotoOrganizerPanel },
];

export const pages = { "/organize": PhotoOrganizerPage };
