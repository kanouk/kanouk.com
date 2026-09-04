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
	allMedia,
	contentPage,
	createArticleDraft,
	createDraft,
	createPhotoFromMedia,
	getContent,
	issueHandoff,
	mediaPage,
	mediaUsage,
	publishDraft,
	recordOperation,
	StudioApiError,
	type StudioMediaItem,
	updateDraft,
	uploadPhoto,
} from "./api";
import {
	applyBulkPatch,
	duplicateGroups,
	mediaPreviewUrl,
	mediaUrl,
	photoReviewFlags,
	sparsePositions,
	textValue,
	type BulkTextMode,
	type ReviewFlag,
} from "./domain";
import "./studio.css";

const ADMIN_ROOT = "/_emdash/admin/plugins/yohaku-photo-studio";
const CORE_ROOT = "/_emdash/admin";

const FLAG_LABELS: Record<ReviewFlag, string> = {
	"missing-caption": "キャプションなし",
	"missing-alt": "altなし",
	"has-location": "位置情報あり",
	"broken-media": "画像参照エラー",
	"unpublished": "未公開",
};

function dataOf(item: ContentItem): Record<string, unknown> {
	return item.data ?? {};
}

function imageOf(item: ContentItem): string | null {
	return mediaUrl(dataOf(item).image);
}

function labelOf(item: ContentItem): string {
	const data = dataOf(item);
	return textValue(data.caption) || textValue(data.title) || item.slug || item.id;
}

function statusLabel(item: ContentItem): string {
	if (item.status !== "published") return "下書き";
	return item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId
		? "公開中・変更あり"
		: "公開済み";
}

function href(path: string): string {
	return `${ADMIN_ROOT}${path}`;
}

function photoEditHref(id: string): string {
	return `${CORE_ROOT}/content/photos/${encodeURIComponent(id)}?locale=ja`;
}

function albumEditHref(id: string): string {
	return `${CORE_ROOT}/content/albums/${encodeURIComponent(id)}?locale=ja`;
}

function Preview({ item, size = 96 }: { item: ContentItem; size?: number }) {
	const src = mediaPreviewUrl(dataOf(item).image, size > 480 ? 768 : size > 320 ? 480 : 320) ?? imageOf(item);
	return src
		? <img className="studio-thumb" src={src} alt="" width={size} height={size} loading="lazy" />
		: <span className="studio-thumb studio-thumb--empty" aria-label="画像なし">画像なし</span>;
}

function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "warn" | "ok" | "danger" }) {
	return <span className={`studio-badge studio-badge--${tone}`}>{children}</span>;
}

function ErrorBox({ error }: { error: unknown }) {
	if (!error) return null;
	return <p className="studio-alert studio-alert--error" role="alert">
		{error instanceof Error ? error.message : "操作に失敗しました。"}
	</p>;
}

function Loading() {
	return <p className="studio-muted" role="status">読み込んでいます…</p>;
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
	return <header className="studio-page-header">
		<div><p className="studio-eyebrow">kanouk.com</p><h1>{title}</h1><p>{description}</p></div>
		{actions && <div className="studio-actions">{actions}</div>}
	</header>;
}

function Nav() {
	return <nav className="studio-nav" aria-label="Studio">
		<a href={href("/")}>概要</a>
		<a href={href("/articles")}>記事</a>
		<a href={href("/pages")}>固定ページ</a>
		<a href={href("/photos")}>写真</a>
		<a href={href("/albums")}>アルバム</a>
		<a href={href("/review")}>要確認</a>
		<a href={href("/media")}>高度な管理</a>
	</nav>;
}

function StudioPage({ children }: { children: React.ReactNode }) {
	return <main className="studio-shell"><Nav />{children}</main>;
}

function HandoffButton({ returnTo = "/albums" }: { returnTo?: string }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	return <>
		<button className="studio-button studio-button--primary" type="button" disabled={busy} onClick={async () => {
			setBusy(true); setError(null);
			try { window.location.assign(await issueHandoff(returnTo)); }
			catch (cause) { setError(cause); setBusy(false); }
		}}>{busy ? "開始しています…" : "公開写真を管理する"}</button>
		<ErrorBox error={error} />
	</>;
}

export function DashboardPage() {
	return <StudioPage>
		<PageHeader
			title="Studio"
			description="記事・写真・アルバムの日常運用を、内部データ構造を意識せず進めるための作業場所です。"
			actions={<HandoffButton />}
		/>
		<section className="studio-dashboard-grid">
			<a className="studio-card" href={href("/articles?new=1")}><span>ブログ</span><strong>新しい記事を書く</strong><small>日本語・カノを既定にして下書きを作成</small></a>
			<a className="studio-card" href={href("/pages")}><span>ブログ</span><strong>固定ページを管理</strong><small>一覧、下書き作成、本文編集、公開</small></a>
			<a className="studio-card" href={href("/albums")}><span>写真</span><strong>写真を追加する</strong><small>Mediaと公開写真を一つの操作で登録</small></a>
			<a className="studio-card" href={href("/albums?new=1")}><span>写真</span><strong>アルバムを作る</strong><small>写真・基本情報・公開を一つの画面で管理</small></a>
			<a className="studio-card" href={href("/articles?status=draft")}><span>ブログ</span><strong>最近の下書き</strong><small>Studioから下書きと公開状態を確認</small></a>
		</section>
		<section className="studio-principles">
			<h2>画像の扱い</h2>
			<div><p><strong>独立して残す写真</strong><br />写真ライブラリからアルバムまたはStreamへ追加し、記事では既存写真を参照します。</p><p><strong>記事だけで使う素材</strong><br />スクリーンショット、図、合成カバーは記事素材としてMediaへ保存します。</p></div>
			<p className="studio-muted">同じ画像バイトはEmDashがSHA-256で重複排除します。StudioはD1/R2を直接更新しません。</p>
		</section>
	</StudioPage>;
}

function articleEditHref(id: string): string {
	return `${CORE_ROOT}/content/posts/${encodeURIComponent(id)}?locale=ja`;
}

function NewArticle({ onCreated }: { onCreated: (item: ContentItem) => void }) {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	return <section className="studio-create-card">
		<h2>新しい記事</h2>
		<p className="studio-muted">日本語、投稿日時は現在、著者は「カノ」で下書きを作ります。</p>
		<label>タイトル<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
		<div className="studio-actions"><button className="studio-button studio-button--primary" disabled={busy || !title.trim()} onClick={async () => {
			setBusy(true); setError(null);
			try { const result = await createArticleDraft(title.trim()); onCreated(result.item); window.location.assign(articleEditHref(result.item.id)); }
			catch (cause) { setError(cause); setBusy(false); }
		}}>{busy ? "作成中…" : "下書きを作って本文を書く"}</button></div>
		<ErrorBox error={error} />
	</section>;
}

function ArticleQuickEditor({ item, onUpdated }: { item: ContentItem; onUpdated: (item: ContentItem) => void }) {
	const [draft, setDraft] = useState(() => ({
		title: textValue(dataOf(item).title),
		excerpt: textValue(dataOf(item).excerpt),
		published_on: textValue(dataOf(item).published_on).slice(0, 16),
	}));
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState<unknown>(null);
	useEffect(() => setDraft({
		title: textValue(dataOf(item).title),
		excerpt: textValue(dataOf(item).excerpt),
		published_on: textValue(dataOf(item).published_on).slice(0, 16),
	}), [item.id, item.updatedAt]);
	return <aside className="studio-editor">
		<header><div><span className="studio-eyebrow">記事の基本情報</span><h2>{labelOf(item)}</h2></div><Badge tone={item.status === "published" ? "ok" : "warn"}>{statusLabel(item)}</Badge></header>
		<label>タイトル<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
		<label>抜粋<textarea value={draft.excerpt} onChange={(event) => setDraft({ ...draft, excerpt: event.target.value })} /></label>
		<label>投稿日<input type="datetime-local" value={draft.published_on} onChange={(event) => setDraft({ ...draft, published_on: event.target.value })} /></label>
		<div className="studio-actions"><button className="studio-button studio-button--primary" disabled={busy} onClick={async () => {
			setBusy(true); setError(null);
			try { const current = await getContent("posts", item.id); const result = await updateDraft("posts", item.id, current._rev, draft); onUpdated(result.item); setMessage("下書き保存済み"); }
			catch (cause) { setError(cause instanceof StudioApiError && cause.status === 409 ? new Error("競合があります。最新状態を読み直してください。") : cause); }
			finally { setBusy(false); }
		}}>下書き保存</button><button className="studio-button" disabled={busy} onClick={async () => {
			setBusy(true); setError(null); try { const result = await publishDraft("posts", item.id); onUpdated(result.item); setMessage("公開済み"); } catch (cause) { setError(cause); } finally { setBusy(false); }
		}}>公開</button><a className="studio-button" href={articleEditHref(item.id)}>本文・画像・分類を編集</a></div>
		{message && <p className="studio-success" role="status">{message}</p>}<ErrorBox error={error} />
	</aside>;
}

export function ArticlePage() {
	const [items, setItems] = useState<ContentItem[]>([]);
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [showNew, setShowNew] = useState(false);
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setShowNew(params.get("new") === "1"); setStatus(params.get("status") ?? "");
	}, []);
	useEffect(() => {
		const timer = window.setTimeout(() => {
			setLoading(true); setError(null);
			contentPage("posts", { limit: 100, search: search || undefined, status: status || undefined, orderBy: "published_on", order: "desc" })
				.then((page) => { setItems(page.items); setSelectedId((current) => current && page.items.some((item) => item.id === current) ? current : page.items[0]?.id ?? null); })
				.catch(setError).finally(() => setLoading(false));
		}, 250);
		return () => window.clearTimeout(timer);
	}, [search, status]);
	const selected = items.find((item) => item.id === selectedId) ?? null;
	const updateItem = (updated: ContentItem) => setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
	return <StudioPage>
		<PageHeader title="記事" description="新規作成、下書き、公開状態をStudioで管理します。本文では既存の余白ブロックと画像ロールを使えます。" actions={<button className="studio-button studio-button--primary" onClick={() => setShowNew((value) => !value)}>新しい記事</button>} />
		{showNew && <NewArticle onCreated={(item) => setItems((current) => [item, ...current])} />}
		<div className="studio-toolbar studio-toolbar--articles"><label>検索<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>状態<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">すべて</option><option value="draft">下書き</option><option value="published">公開済み</option></select></label></div>
		{loading && <Loading />}<ErrorBox error={error} />
		<div className="studio-library-layout"><section className="studio-article-list">{items.map((item) => <button className={selectedId === item.id ? "is-selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><span><strong>{labelOf(item)}</strong><small>{textValue(dataOf(item).published_on).slice(0, 10) || "日付なし"}</small></span><Badge tone={item.status === "published" ? "ok" : "warn"}>{statusLabel(item)}</Badge></button>)}</section>{selected && <ArticleQuickEditor item={selected} onUpdated={updateItem} />}</div>
	</StudioPage>;
}

function fixedPageEditHref(id: string): string {
	return `${CORE_ROOT}/content/pages/${encodeURIComponent(id)}?locale=ja`;
}

function FixedPageEditor({ item, onUpdated }: { item: ContentItem; onUpdated: (item: ContentItem) => void }) {
	const [title, setTitle] = useState(textValue(dataOf(item).title));
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState<unknown>(null);
	useEffect(() => setTitle(textValue(dataOf(item).title)), [item.id, item.updatedAt]);
	return <aside className="studio-editor">
		<header><div><span className="studio-eyebrow">固定ページ</span><h2>{labelOf(item)}</h2></div><Badge tone={item.status === "published" ? "ok" : "warn"}>{statusLabel(item)}</Badge></header>
		<label>タイトル<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
		<div className="studio-actions"><button className="studio-button studio-button--primary" disabled={busy || !title.trim()} onClick={async () => {
			setBusy(true); setError(null); setMessage("");
			try { const current = await getContent("pages", item.id); const result = await updateDraft("pages", item.id, current._rev, { title: title.trim() }); onUpdated(result.item); setMessage("下書き保存済み"); }
			catch (cause) { setError(cause instanceof StudioApiError && cause.status === 409 ? new Error("競合があります。最新状態を読み直してください。") : cause); }
			finally { setBusy(false); }
		}}>下書き保存</button><button className="studio-button" disabled={busy} onClick={async () => {
			setBusy(true); setError(null); setMessage(""); try { const result = await publishDraft("pages", item.id); onUpdated(result.item); setMessage("公開済み"); } catch (cause) { setError(cause); } finally { setBusy(false); }
		}}>公開</button><a className="studio-button" href={fixedPageEditHref(item.id)}>本文・画像・SEOを編集</a>{item.slug && <a className="studio-button" href={`/pages/${encodeURIComponent(item.slug)}`} target="_blank" rel="noreferrer">表示</a>}</div>
		{message && <p className="studio-success" role="status">{message}</p>}<ErrorBox error={error} />
	</aside>;
}

export function FixedPagePage() {
	const [items, setItems] = useState<ContentItem[]>([]);
	const [search, setSearch] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [newTitle, setNewTitle] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => {
		const timer = window.setTimeout(() => {
			setLoading(true); setError(null);
			contentPage("pages", { limit: 100, search: search || undefined, orderBy: "updatedAt", order: "desc" })
				.then((page) => { setItems(page.items); setSelectedId((current) => current && page.items.some((item) => item.id === current) ? current : page.items[0]?.id ?? null); })
				.catch(setError).finally(() => setLoading(false));
		}, 250);
		return () => window.clearTimeout(timer);
	}, [search]);
	const selected = items.find((item) => item.id === selectedId) ?? null;
	const updateItem = (updated: ContentItem) => setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
	return <StudioPage>
		<PageHeader title="固定ページ" description="固定ページの一覧、下書き作成、本文編集、公開をここから進めます。" actions={<button className="studio-button studio-button--primary" onClick={() => setShowNew((value) => !value)}>新しい固定ページ</button>} />
		{showNew && <section className="studio-create-card"><h2>新しい固定ページ</h2><label>タイトル<input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} /></label><div className="studio-actions"><button className="studio-button studio-button--primary" disabled={busy || !newTitle.trim()} onClick={async () => {
			setBusy(true); setError(null);
			try { const result = await createDraft("pages", { title: newTitle.trim(), content: [], source_metadata: { studio_created: true } }); setItems((current) => [result.item, ...current]); setSelectedId(result.item.id); setNewTitle(""); setShowNew(false); window.location.assign(fixedPageEditHref(result.item.id)); }
			catch (cause) { setError(cause); } finally { setBusy(false); }
		}}>{busy ? "作成中…" : "下書きを作って本文を書く"}</button></div></section>}
		<div className="studio-toolbar studio-toolbar--articles"><label>検索<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
		{loading && <Loading />}<ErrorBox error={error} />
		<div className="studio-library-layout"><section className="studio-article-list">{items.map((item) => <button className={selectedId === item.id ? "is-selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><span><strong>{labelOf(item)}</strong><small>/{item.slug || "下書き"}</small></span><Badge tone={item.status === "published" ? "ok" : "warn"}>{statusLabel(item)}</Badge></button>)}</section>{selected && <FixedPageEditor item={selected} onUpdated={updateItem} />}</div>
	</StudioPage>;
}

function useAlbums() {
	const [albums, setAlbums] = useState<ContentItem[]>([]);
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(true);
	useEffect(() => { allContent("albums", { orderBy: "captured_from", order: "desc" }).then(setAlbums).catch(setError).finally(() => setLoading(false)); }, []);
	return { albums, error, loading };
}

function PhotoQuickEditor({ item, albums, onUpdated, onPrevious, onNext }: { item: ContentItem; albums: ContentItem[]; onUpdated: (item: ContentItem) => void; onPrevious?: () => void; onNext?: () => void }) {
	const [draft, setDraft] = useState(() => ({
		title: textValue(dataOf(item).title),
		caption: textValue(dataOf(item).caption),
		alt: textValue(dataOf(item).alt),
		captured_at: textValue(dataOf(item).captured_at).slice(0, 16),
		album: textValue(dataOf(item).album),
	}));
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState<unknown>(null);
	useEffect(() => setDraft({
		title: textValue(dataOf(item).title),
		caption: textValue(dataOf(item).caption),
		alt: textValue(dataOf(item).alt),
		captured_at: textValue(dataOf(item).captured_at).slice(0, 16),
		album: textValue(dataOf(item).album),
	}), [item.id, item.updatedAt]);

	const save = async () => {
		setBusy(true); setError(null); setMessage("保存中…");
		try {
			const current = await getContent("photos", item.id);
			const result = await updateDraft("photos", item.id, current._rev, draft);
			onUpdated(result.item); setMessage("下書き保存済み");
		} catch (cause) {
			setError(cause instanceof StudioApiError && cause.status === 409 ? new Error("競合があります。最新状態を読み直してから再適用してください。") : cause);
			setMessage("");
		} finally { setBusy(false); }
	};
	return <aside className="studio-editor">
		<header><div><span className="studio-eyebrow">クイック編集</span><h2>{labelOf(item)}</h2></div><Badge tone={item.status === "published" ? "ok" : "warn"}>{statusLabel(item)}</Badge></header>
		<Preview item={item} size={320} />
		<label>タイトル<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
		<label>キャプション<textarea value={draft.caption} placeholder="キャプションを追加" onChange={(event) => setDraft({ ...draft, caption: event.target.value })} /></label>
		<label>代替テキスト<input value={draft.alt} onChange={(event) => setDraft({ ...draft, alt: event.target.value })} /></label>
		<label>撮影日<input type="datetime-local" value={draft.captured_at} onChange={(event) => setDraft({ ...draft, captured_at: event.target.value })} /></label>
		<label>アルバム<select value={draft.album} onChange={(event) => setDraft({ ...draft, album: event.target.value })}>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
		<div className="studio-actions"><button className="studio-button" disabled={!onPrevious || busy} onClick={onPrevious}>← 前</button><button className="studio-button" disabled={!onNext || busy} onClick={onNext}>次 →</button><button className="studio-button studio-button--primary" disabled={busy} onClick={save}>下書き保存</button><button className="studio-button" disabled={busy} onClick={async () => { setBusy(true); try { const result = await publishDraft("photos", item.id); onUpdated(result.item); setMessage("公開済み"); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>公開</button><a className="studio-button" href={photoEditHref(item.id)}>詳細編集</a></div>
		{message && <p className="studio-success" role="status">{message}</p>}<ErrorBox error={error} />
	</aside>;
}

export function PhotoLibraryPage() {
	const { albums, error: albumError } = useAlbums();
	const [items, setItems] = useState<ContentItem[]>([]);
	const [nextCursor, setNextCursor] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [search, setSearch] = useState("");
	const [albumFilter, setAlbumFilter] = useState("");
	const [reviewFilter, setReviewFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState("");
	const [kindFilter, setKindFilter] = useState("");
	const [capturedFrom, setCapturedFrom] = useState("");
	const [capturedTo, setCapturedTo] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [bulkBusy, setBulkBusy] = useState(false);
	const [bulkText, setBulkText] = useState("");
	const [bulkField, setBulkField] = useState<"caption" | "alt">("caption");
	const [bulkMode, setBulkMode] = useState<BulkTextMode>("overwrite");
	const [bulkFailures, setBulkFailures] = useState<Array<{ id: string; reason: string }>>([]);

	const load = async (cursor?: string) => {
		setLoading(true); setError(null);
		try {
			const page = await contentPage("photos", { cursor, limit: 50, search: search || undefined, orderBy: "captured_at", order: "desc" });
			setItems((current) => cursor ? [...current, ...page.items] : page.items);
			setNextCursor(page.nextCursor);
			if (!cursor && !selectedId && page.items[0]) setSelectedId(page.items[0].id);
		} catch (cause) { setError(cause); }
		finally { setLoading(false); }
	};
	useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [search]);

	const visible = useMemo(() => items.filter((item) => {
		const data = dataOf(item);
		if (albumFilter && data.album !== albumFilter) return false;
		if (statusFilter && item.status !== statusFilter) return false;
		if (kindFilter && data.kind !== kindFilter) return false;
		const captured = textValue(data.captured_at).slice(0, 10);
		if (capturedFrom && (!captured || captured < capturedFrom)) return false;
		if (capturedTo && (!captured || captured > capturedTo)) return false;
		if (reviewFilter && !photoReviewFlags(data, { status: item.status }).includes(reviewFilter as ReviewFlag)) return false;
		return true;
	}), [items, albumFilter, statusFilter, kindFilter, capturedFrom, capturedTo, reviewFilter]);
	const selected = items.find((item) => item.id === selectedId) ?? null;
	const selectedIndex = visible.findIndex((item) => item.id === selectedId);
	const updateItem = (updated: ContentItem) => setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
	const toggleChecked = (id: string) => setChecked((current) => {
		const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next;
	});
	const runBulk = async () => {
		const targets = [...checked]; if (!targets.length || !bulkText) return;
		setBulkBusy(true); setBulkFailures([]);
		const failures: Array<{ id: string; reason: string }> = [];
		const succeeded: string[] = [];
		for (const id of targets) {
			try {
				const current = await getContent("photos", id);
				const data = applyBulkPatch(dataOf(current.item), { [bulkField]: { value: bulkText, mode: bulkMode } });
				const updated = await updateDraft("photos", id, current._rev, { [bulkField]: data[bulkField] });
				updateItem(updated.item); succeeded.push(id);
			} catch (cause) { failures.push({ id, reason: cause instanceof Error ? cause.message : "不明なエラー" }); }
		}
		setBulkFailures(failures); setChecked(new Set(failures.map((failure) => failure.id)));
		await recordOperation({ kind: "bulk-text-edit", status: failures.length ? "partial" : "complete", targetIds: targets, failures, metadata: { field: bulkField, mode: bulkMode, succeeded: succeeded.length } }).catch(() => undefined);
		if (!failures.length) setBulkText("");
		setBulkBusy(false);
	};
	const selectionFrozen = checked.size > 0 && bulkText.length > 0;

	return <StudioPage>
		<PageHeader title="写真ライブラリ" description="ファイル名ではなく写真を見て選び、一覧を離れずに編集します。" actions={<a className="studio-button" href={href("/albums")}>アルバム作業画面</a>} />
		<div className="studio-toolbar">
			<label>検索<input type="search" placeholder="タイトル・キャプション・ファイル名" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
			<label>アルバム<select value={albumFilter} onChange={(event) => setAlbumFilter(event.target.value)}><option value="">すべて</option>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
			<label>要確認<select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}><option value="">すべて</option>{Object.entries(FLAG_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
			<label>公開状態<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">すべて</option><option value="draft">下書き</option><option value="published">公開済み</option></select></label>
			<label>種類<select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="">すべて</option><option value="image">写真</option><option value="video">動画</option></select></label>
			<label>撮影日（開始）<input type="date" value={capturedFrom} onChange={(event) => setCapturedFrom(event.target.value)} /></label>
			<label>撮影日（終了）<input type="date" value={capturedTo} onChange={(event) => setCapturedTo(event.target.value)} /></label>
		</div>
		<ErrorBox error={error ?? albumError} />
		{checked.size > 0 && <section className="studio-bulk" aria-label="一括編集">
			<strong>{checked.size}点を選択中</strong>
			<select aria-label="対象フィールド" value={bulkField} disabled={bulkBusy} onChange={(event) => setBulkField(event.target.value as "caption" | "alt")}><option value="caption">キャプション</option><option value="alt">alt</option></select>
			<select aria-label="変更方法" value={bulkMode} disabled={bulkBusy} onChange={(event) => setBulkMode(event.target.value as BulkTextMode)}><option value="overwrite">上書き</option><option value="prepend">先頭へ追加</option><option value="append">末尾へ追加</option></select>
			<input value={bulkText} disabled={bulkBusy} onChange={(event) => setBulkText(event.target.value)} placeholder="変更する値" />
			<button className="studio-button studio-button--primary" disabled={bulkBusy || !bulkText} onClick={runBulk}>{bulkBusy ? "処理中…" : "下書きへ適用"}</button>
			<button className="studio-button" disabled={bulkBusy} onClick={() => { setChecked(new Set()); setBulkText(""); }}>選択解除</button>
			{bulkFailures.length > 0 && <div className="studio-alert studio-alert--error"><p>{bulkFailures.length}件が失敗しました。失敗分だけ選択を保持しています。</p><ul>{bulkFailures.map((failure) => <li key={failure.id}><code>{failure.id}</code>: {failure.reason}</li>)}</ul></div>}
		</section>}
		<div className="studio-library-layout">
			<section><p className="studio-muted">表示中 {visible.length}点{nextCursor ? "（続きあり）" : ""}</p><div className="studio-photo-grid">
				{visible.map((item) => <article className={`studio-photo-card ${selectedId === item.id ? "is-selected" : ""}`} key={item.id}>
					<label className="studio-check"><input type="checkbox" checked={checked.has(item.id)} disabled={bulkBusy || selectionFrozen} onChange={() => toggleChecked(item.id)} /><span>選択</span></label>
					<button className="studio-photo-select" type="button" onClick={() => setSelectedId(item.id)}><Preview item={item} /><strong>{labelOf(item)}</strong><small>{statusLabel(item)}</small></button>
					<div className="studio-badges">{photoReviewFlags(dataOf(item), { status: item.status }).map((flag) => <Badge key={flag} tone={flag === "has-location" ? "danger" : "warn"}>{FLAG_LABELS[flag]}</Badge>)}</div>
				</article>)}
			</div>{loading && <Loading />}{nextCursor && !loading && <button className="studio-button studio-load-more" onClick={() => load(nextCursor)}>さらに50点を表示</button>}</section>
			{selected && <PhotoQuickEditor item={selected} albums={albums} onUpdated={updateItem} onPrevious={selectedIndex > 0 ? () => setSelectedId(visible[selectedIndex - 1].id) : undefined} onNext={selectedIndex >= 0 && selectedIndex < visible.length - 1 ? () => setSelectedId(visible[selectedIndex + 1].id) : undefined} />}
		</div>
	</StudioPage>;
}

function AlbumWorkspace({ album, albums, onAlbumUpdated }: { album: ContentItem; albums: ContentItem[]; onAlbumUpdated: (item: ContentItem) => void }) {
	const [photos, setPhotos] = useState<ContentItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [undoOrder, setUndoOrder] = useState<Array<{ id: string; position: number }> | null>(null);
	const [moveUndo, setMoveUndo] = useState<{ photoId: string; albumId: string; position: number } | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	const [albumDraft, setAlbumDraft] = useState({ title: labelOf(album), description: textValue(dataOf(album).description) });

	const reload = async () => {
		setLoading(true); setError(null);
		try { setPhotos(await allContent("photos", { fieldFilters: { album: album.id }, orderBy: "position", order: "asc" })); }
		catch (cause) { setError(cause); }
		finally { setLoading(false); }
	};
	useEffect(() => { setAlbumDraft({ title: labelOf(album), description: textValue(dataOf(album).description) }); void reload(); }, [album.id]);

	const persistOrder = async (next: ContentItem[]) => {
		setBusy(true); setMessage("並び順を保存中…"); setError(null);
		const positions = sparsePositions(next.length);
		const changed = next.flatMap((item, index) => Number(dataOf(item).position) === positions[index] ? [] : [{ item, position: positions[index] }]);
		setUndoOrder(changed.map(({ item }) => ({ id: item.id, position: Number(dataOf(item).position) || 0 })));
		const failures: Array<{ id: string; reason: string }> = [];
		for (const { item, position } of changed) {
			try {
				const current = await getContent("photos", item.id);
				await updateDraft("photos", item.id, current._rev, { position });
			} catch (cause) { failures.push({ id: item.id, reason: cause instanceof Error ? cause.message : "不明なエラー" }); }
		}
		await recordOperation({ kind: "album-reorder", status: failures.length ? "partial" : "complete", targetIds: changed.map(({ item }) => item.id), failures, metadata: { albumId: album.id, total: next.length } }).catch(() => undefined);
		setPhotos(next.map((item, index) => ({ ...item, data: { ...dataOf(item), position: positions[index] } }))); setMessage(failures.length ? `${failures.length}点の保存に失敗` : `${changed.length}点の並び順を下書き保存済み`); setBusy(false);
	};
	const move = (index: number, delta: number) => {
		const target = index + delta; if (target < 0 || target >= photos.length || busy) return;
		const next = [...photos]; [next[index], next[target]] = [next[target], next[index]]; void persistOrder(next);
	};
	const undo = async () => {
		if (!undoOrder) return; setBusy(true); const failures: Array<{ id: string; reason: string }> = [];
		for (const previous of undoOrder) {
			try { const current = await getContent("photos", previous.id); await updateDraft("photos", previous.id, current._rev, { position: previous.position }); }
			catch (cause) { failures.push({ id: previous.id, reason: cause instanceof Error ? cause.message : "不明なエラー" }); }
		}
		await recordOperation({ kind: "album-reorder-undo", status: failures.length ? "partial" : "complete", targetIds: undoOrder.map((entry) => entry.id), failures, metadata: { albumId: album.id } }).catch(() => undefined);
		setUndoOrder(null); await reload(); setBusy(false);
	};
	const movePhoto = async (photo: ContentItem, targetAlbumId: string) => {
		if (!targetAlbumId || targetAlbumId === album.id || busy) return;
		setBusy(true); setError(null);
		try {
			const targetPhotos = await allContent("photos", { fieldFilters: { album: targetAlbumId }, orderBy: "position", order: "desc" });
			const position = Math.max(0, ...targetPhotos.map((item) => Number(dataOf(item).position) || 0)) + 1024;
			const current = await getContent("photos", photo.id);
			await updateDraft("photos", photo.id, current._rev, { album: targetAlbumId, position });
			setMoveUndo({ photoId: photo.id, albumId: album.id, position: Number(dataOf(photo).position) || 0 });
			setPhotos((items) => items.filter((item) => item.id !== photo.id));
			const targetAlbum = albums.find((item) => item.id === targetAlbumId);
			setMessage(`「${labelOf(photo)}」を${targetAlbum ? labelOf(targetAlbum) : targetAlbumId}へ移動しました（下書き）`);
			await recordOperation({ kind: "photo-move", status: "complete", targetIds: [photo.id], metadata: { fromAlbumId: album.id, toAlbumId: targetAlbumId } }).catch(() => undefined);
		} catch (cause) { setError(cause); } finally { setBusy(false); }
	};
	const undoMove = async () => {
		if (!moveUndo || busy) return;
		setBusy(true); setError(null);
		try { const current = await getContent("photos", moveUndo.photoId); await updateDraft("photos", moveUndo.photoId, current._rev, { album: moveUndo.albumId, position: moveUndo.position }); setMoveUndo(null); await reload(); setMessage("直前の移動を取り消しました"); }
		catch (cause) { setError(cause); } finally { setBusy(false); }
	};

	return <section className="studio-workspace">
		<div className="studio-workspace__meta">
			<h2>基本情報</h2>
			<label>アルバム名<input value={albumDraft.title} onChange={(event) => setAlbumDraft({ ...albumDraft, title: event.target.value })} /></label>
			<label>説明<textarea value={albumDraft.description} onChange={(event) => setAlbumDraft({ ...albumDraft, description: event.target.value })} /></label>
			<div className="studio-actions"><button className="studio-button studio-button--primary" disabled={busy} onClick={async () => { setBusy(true); try { const current = await getContent("albums", album.id); const result = await updateDraft("albums", album.id, current._rev, albumDraft); onAlbumUpdated(result.item); setMessage("基本情報を下書き保存済み"); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>下書き保存</button><button className="studio-button" disabled={busy} onClick={async () => { setBusy(true); try { const result = await publishDraft("albums", album.id); onAlbumUpdated(result.item); setMessage("アルバムを公開済み"); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>公開</button><a className="studio-button" href={albumEditHref(album.id)}>高度な編集</a></div>
		</div>
		<div className="studio-workspace__photos">
			<header><div><h2>写真</h2><p className="studio-muted">{photos.length}点・ドラッグ、矢印、キーボード操作に対応</p></div><div className="studio-actions"><button className="studio-button" disabled={busy || photos.length < 2} onClick={() => void persistOrder([...photos].sort((left, right) => textValue(dataOf(left).captured_at).localeCompare(textValue(dataOf(right).captured_at))))}>撮影日順</button><label className="studio-button studio-upload">写真を追加<input type="file" accept="image/*" multiple hidden disabled={busy} onChange={async (event) => {
				const files = [...(event.target.files ?? [])].slice(0, 20); if (!files.length) return;
				setBusy(true); setError(null); const failures: Array<{ id: string; reason: string }> = []; const created: string[] = [];
				let position = Math.max(0, ...photos.map((item) => Number(dataOf(item).position) || 0));
				for (const file of files) { try { position += 1024; const result = await uploadPhoto(file, album.id, position); created.push(result.item.id); } catch (cause) { failures.push({ id: file.name, reason: cause instanceof Error ? cause.message : "不明なエラー" }); } }
				await recordOperation({ kind: "photo-upload", status: failures.length ? "partial" : "complete", targetIds: created, failures, metadata: { albumId: album.id, requested: files.length } }).catch(() => undefined);
				setMessage(failures.length ? `${created.length}点追加・${failures.length}点失敗` : `${created.length}点を下書きへ追加`); await reload(); setBusy(false); event.target.value = "";
			}} /></label>{undoOrder && <button className="studio-button" disabled={busy} onClick={undo}>並べ替えを取り消す</button>}{moveUndo && <button className="studio-button" disabled={busy} onClick={undoMove}>移動を取り消す</button>}</div></header>
			{loading ? <Loading /> : <div className="studio-album-grid">{photos.map((photo, index) => <article
				key={photo.id}
				className="studio-album-photo"
				draggable={!busy}
				onDragStart={() => setDragId(photo.id)}
				onDragOver={(event) => event.preventDefault()}
				onDrop={() => {
					if (!dragId || dragId === photo.id) return;
					const next = [...photos]; const from = next.findIndex((item) => item.id === dragId); const [moved] = next.splice(from, 1); next.splice(index, 0, moved); setDragId(null); void persistOrder(next);
				}}
			>
				<Preview item={photo} /><strong>{labelOf(photo)}</strong><div className="studio-badges"><Badge>{index + 1}</Badge><Badge tone={photo.status === "published" ? "ok" : "warn"}>{statusLabel(photo)}</Badge></div>
				<div className="studio-icon-actions"><button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label="前へ移動">↑</button><button type="button" disabled={busy || index === photos.length - 1} onClick={() => move(index, 1)} aria-label="後ろへ移動">↓</button><button type="button" disabled={busy} onClick={async () => { setBusy(true); try { const current = await getContent("albums", album.id); await updateDraft("albums", album.id, current._rev, { cover_image: dataOf(photo).image }); setMessage("カバーを下書き保存済み"); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>カバー</button><button type="button" disabled={busy || photo.status === "published"} onClick={async () => { setBusy(true); try { await publishDraft("photos", photo.id); setMessage("写真を公開しました"); await reload(); } catch (cause) { setError(cause); } finally { setBusy(false); } }}>公開</button><a href={photoEditHref(photo.id)}>編集</a>{photo.slug && <a href={`https://photos.kanouk.com/p/${encodeURIComponent(photo.slug)}`} target="_blank" rel="noreferrer">表示</a>}<label>移動<select value={album.id} disabled={busy} onChange={(event) => void movePhoto(photo, event.target.value)}>{albums.map((target) => <option key={target.id} value={target.id}>{labelOf(target)}</option>)}</select></label></div>
			</article>)}</div>}
		</div>
		{message && <p className="studio-success" role="status">{message}</p>}<ErrorBox error={error} />
	</section>;
}

export function AlbumWorkspacePage() {
	const { albums, error, loading } = useAlbums();
	const [selectedId, setSelectedId] = useState("");
	const [items, setItems] = useState<ContentItem[]>([]);
	const [showNew, setShowNew] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<unknown>(null);
	useEffect(() => setItems(albums), [albums]);
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const requested = params.get("album");
		setShowNew(params.get("new") === "1");
		if (!selectedId && albums.length) setSelectedId(requested && albums.some((album) => album.id === requested) ? requested : albums[0].id);
	}, [albums, selectedId]);
	const selected = items.find((album) => album.id === selectedId);
	return <StudioPage>
		<PageHeader title="アルバム編集" description="写真を見ながら追加・並べ替え・カバー設定・公開まで進めます。" actions={<><button className="studio-button" onClick={() => setShowNew((value) => !value)}>新しいアルバム</button><HandoffButton returnTo={selected?.slug ? `/albums/${selected.slug}` : "/albums"} /></>} />
		<ErrorBox error={error} />
		{showNew && <section className="studio-create-card"><h2>新しいアルバム</h2><label>アルバム名<input autoFocus value={newTitle} onChange={(event) => setNewTitle(event.target.value)} /></label><div className="studio-actions"><button className="studio-button studio-button--primary" disabled={creating || !newTitle.trim()} onClick={async () => {
			setCreating(true); setCreateError(null);
			try {
				const result = await createDraft("albums", { title: newTitle.trim(), description: "", sort_method: "position", sort_direction: "asc", allow_downloads: false, source_metadata: { studio_created: true } });
				setItems((current) => [result.item, ...current]); setSelectedId(result.item.id); setNewTitle(""); setShowNew(false);
			} catch (cause) { setCreateError(cause); } finally { setCreating(false); }
		}}>{creating ? "作成中…" : "下書きを作る"}</button></div><ErrorBox error={createError} /></section>}
		<label className="studio-album-picker">作業するアルバム<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{items.map((album) => <option key={album.id} value={album.id}>{labelOf(album)} — {statusLabel(album)}</option>)}</select></label>
		{loading ? <Loading /> : !selected && !error ? <p className="studio-empty">アルバムがありません。「新しいアルバム」から下書きを作ってください。</p> : selected && <AlbumWorkspace album={selected} albums={items} onAlbumUpdated={(updated) => setItems((current) => current.map((item) => item.id === updated.id ? updated : item))} />}
	</StudioPage>;
}

type QueueItem = { id: string; kind: string; label: string; reason: string; href: string; tone?: "warn" | "danger" };

export function ReviewQueuePage() {
	const [photos, setPhotos] = useState<ContentItem[]>([]);
	const [media, setMedia] = useState<StudioMediaItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [usageDetail, setUsageDetail] = useState<{ title: string; lines: string[] } | null>(null);
	useEffect(() => { Promise.all([allContent("photos"), allMedia()]).then(([photoItems, mediaItems]) => { setPhotos(photoItems); setMedia(mediaItems); }).catch(setError).finally(() => setLoading(false)); }, []);
	const knownMedia = useMemo(() => new Set(media.map((item) => item.id)), [media]);
	const duplicateMedia = useMemo(() => duplicateGroups(media, (item) => item.contentHash), [media]);
	const duplicatePhotos = useMemo(() => duplicateGroups(photos, (item) => textValue(dataOf(item).original_sha256)), [photos]);
	const queue = useMemo(() => {
		const result: QueueItem[] = [];
		for (const photo of photos) {
			for (const flag of photoReviewFlags(dataOf(photo), { status: photo.status, knownMediaIds: knownMedia })) {
				result.push({ id: `${photo.id}:${flag}`, kind: "写真", label: labelOf(photo), reason: FLAG_LABELS[flag], href: photoEditHref(photo.id), tone: flag === "has-location" || flag === "broken-media" ? "danger" : "warn" });
			}
		}
		for (const item of media) {
			if (item.status && item.status !== "ready") result.push({ id: `media:${item.id}:failed`, kind: "Media", label: item.filename, reason: `状態: ${item.status}`, href: `${CORE_ROOT}/media`, tone: "danger" });
			if (item.usage?.coverage.status === "complete" && item.usage.count === 0) result.push({ id: `media:${item.id}:orphan`, kind: "Media", label: item.filename, reason: "参照なし（自動削除しません）", href: `${CORE_ROOT}/media` });
		}
		duplicateMedia.forEach((group, index) => result.push({ id: `duplicate-media:${index}`, kind: "重複候補", label: group.map((item) => item.filename).join(" / "), reason: `同一バイト ${group.length}件・自動統合しません`, href: href("/media") }));
		duplicatePhotos.forEach((group, index) => result.push({ id: `duplicate-photo:${index}`, kind: "重複候補", label: group.map(labelOf).join(" / "), reason: `同じ原本SHA ${group.length}件`, href: href("/photos") }));
		return result;
	}, [photos, media, knownMedia, duplicateMedia, duplicatePhotos]);
	const coverage = media[0]?.usage?.coverage.status ?? "unknown";
	return <StudioPage>
		<PageHeader title="要確認キュー" description="公開前に直したいメタデータ、参照、重複候補を一か所で確認します。" />
		{loading && <Loading />}<ErrorBox error={error} />
		{coverage !== "complete" && !loading && <p className="studio-alert">Media利用状況の網羅性は「{coverage}」です。参照なしを0件や安全とみなしていません。</p>}
		<section className="studio-privacy-note"><h2>位置情報の削除</h2><p>位置情報ありの項目は候補として提示します。写真ピクセルを保持し、明示した対象だけからCMS座標と埋め込みGPSを除く既存の安全なredactionフローで処理してください。Studioからの一括自動削除は行いません。</p></section>
		<p className="studio-muted">要確認 {queue.length}件</p>
		<div className="studio-queue">{queue.map((item) => <article key={item.id}><div><Badge tone={item.tone ?? "warn"}>{item.kind}</Badge><strong>{item.label}</strong><p>{item.reason}</p></div><a className="studio-button" href={item.href}>確認・修正</a></article>)}</div>
		{!loading && queue.length === 0 && <p className="studio-empty">現在の取得範囲に要確認項目はありません。</p>}
		{usageDetail && <section className="studio-modal"><button aria-label="閉じる" onClick={() => setUsageDetail(null)}>×</button><h2>{usageDetail.title}</h2>{usageDetail.lines.map((line) => <p key={line}>{line}</p>)}</section>}
	</StudioPage>;
}

export function MediaPage() {
	const { albums, error: albumError } = useAlbums();
	const [items, setItems] = useState<StudioMediaItem[]>([]);
	const [cursor, setCursor] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [detail, setDetail] = useState<{ item: StudioMediaItem; lines: string[] } | null>(null);
	const [selectedAlbumId, setSelectedAlbumId] = useState("");
	const [convertingId, setConvertingId] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	useEffect(() => { if (!selectedAlbumId && albums[0]) setSelectedAlbumId(albums[0].id); }, [albums, selectedAlbumId]);
	const load = async (next?: string) => { setLoading(true); try { const page = await mediaPage({ cursor: next }); setItems((current) => next ? [...current, ...page.items] : page.items); setCursor(page.nextCursor); } catch (cause) { setError(cause); } finally { setLoading(false); } };
	useEffect(() => { void load(); }, []);
	return <StudioPage>
		<PageHeader title="高度な管理" description="Mediaの技術情報と全参照元を確認します。日常画面から完全削除は行いません。" actions={<a className="studio-button" href={`${CORE_ROOT}/media`}>EmDash Media</a>} />
		<ErrorBox error={error ?? albumError} />
		<label className="studio-album-picker">公開写真として登録するアルバム<select value={selectedAlbumId} onChange={(event) => setSelectedAlbumId(event.target.value)}><option value="">選択してください</option>{albums.map((album) => <option key={album.id} value={album.id}>{labelOf(album)}</option>)}</select></label>
		{message && <p className="studio-success" role="status">{message}</p>}
		<div className="studio-media-table" role="table"><div role="row" className="studio-media-table__head"><span>Media</span><span>状態</span><span>SHA-256</span><span>利用</span></div>{items.map((item) => <div role="row" key={item.id}><span><img src={mediaPreviewUrl(item, 320) ?? item.url} alt="" loading="lazy" /><strong>{item.filename}</strong></span><span><Badge tone={item.status === "ready" || !item.status ? "ok" : "danger"}>{item.status ?? "ready"}</Badge></span><code>{item.contentHash ? `${item.contentHash.slice(0, 12)}…` : "unknown"}</code><span>{item.usage?.coverage.status === "complete" ? `${item.usage.count ?? 0}件` : "unknown"}<button className="studio-link-button" onClick={async () => { try { const usage = await mediaUsage(item.id); setDetail({ item, lines: usage.items.map((entry) => `${entry.collection}: ${entry.title ?? entry.contentId} — ${entry.sources.flatMap((source) => source.occurrences.map((occurrence) => occurrence.fieldPath)).join(", ")}`) }); } catch (cause) { setError(cause); } }}>参照元</button><button className="studio-link-button" disabled={!selectedAlbumId || convertingId === item.id} onClick={async () => {
			setConvertingId(item.id); setError(null); setMessage("");
			try {
				const existing = await allContent("photos", { fieldFilters: { source_id: item.id } });
				if (existing.length) throw new Error("このMediaはすでに公開写真として登録されています。");
				const targetPhotos = await allContent("photos", { fieldFilters: { album: selectedAlbumId }, orderBy: "position", order: "desc" });
				const position = Math.max(0, ...targetPhotos.map((photo) => Number(dataOf(photo).position) || 0)) + 1024;
				const created = await createPhotoFromMedia(item, selectedAlbumId, position);
				setMessage(`「${item.filename}」を公開写真の下書きにしました。`);
				await recordOperation({ kind: "media-to-public-photo", status: "complete", targetIds: [created.item.id], metadata: { mediaId: item.id, albumId: selectedAlbumId } }).catch(() => undefined);
			} catch (cause) { setError(cause); } finally { setConvertingId(null); }
		}}>公開写真にする</button></span></div>)}</div>
		{loading && <Loading />}{cursor && !loading && <button className="studio-button studio-load-more" onClick={() => load(cursor)}>さらに表示</button>}
		{detail && <section className="studio-modal" role="dialog" aria-modal="true"><button aria-label="閉じる" onClick={() => setDetail(null)}>×</button><h2>{detail.item.filename}</h2>{detail.lines.length ? detail.lines.map((line) => <p key={line}>{line}</p>) : <p>現在の利用状況インデックスに参照はありません。完全削除前にはcoverageも確認してください。</p>}</section>}
	</StudioPage>;
}

function ThumbnailColumn({ item }: ContentListColumnCellContext) {
	return <Preview item={item} size={56} />;
}

function PhotoLabelColumn({ item }: ContentListColumnCellContext) {
	return <span title={textValue(dataOf(item).title)}>{labelOf(item)}</span>;
}

function PhotoStateColumn({ item }: ContentListColumnCellContext) {
	return <span><Badge tone={item.status === "published" ? "ok" : "warn"}>{statusLabel(item)}</Badge><small className="studio-column-date">{String(item.updatedAt ?? "").slice(0, 10)}</small></span>;
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
	return <span>{name}</span>;
}

function ReviewColumn({ item }: ContentListColumnCellContext) {
	const flags = photoReviewFlags(dataOf(item), { status: item.status });
	return <div className="studio-badges">{flags.length ? flags.map((flag) => <Badge key={flag} tone={flag === "has-location" ? "danger" : "warn"}>{FLAG_LABELS[flag]}</Badge>) : <Badge tone="ok">確認済み</Badge>}</div>;
}

function AlbumPhotoPanel({ entry }: ContentEditorPanelContext) {
	const [photos, setPhotos] = useState<ContentItem[]>([]);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => { allContent("photos", { fieldFilters: { album: entry.id }, orderBy: "position", order: "asc" }).then(setPhotos).catch(setError); }, [entry.id]);
	const published = photos.filter((photo) => photo.status === "published").length;
	return <div className="studio-panel"><p><strong>{photos.length}点</strong>（公開 {published}・下書き {photos.length - published}）の写真が紐づいています。</p><div className="studio-panel-grid">{photos.slice(0, 24).map((photo) => <span key={photo.id}><a href={photoEditHref(photo.id)} title={`${labelOf(photo)}を編集`}><Preview item={photo} size={72} /></a>{photo.slug && <a href={`https://photos.kanouk.com/p/${encodeURIComponent(photo.slug)}`} target="_blank" rel="noreferrer">表示</a>}</span>)}</div>{photos.length > 24 && <p className="studio-muted">ほか {photos.length - 24}点</p>}<a className="studio-button studio-button--primary" href={href(`/albums?album=${encodeURIComponent(entry.id)}`)}>写真を管理</a><ErrorBox error={error} /></div>;
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
];

export const pages = {
	"/": DashboardPage,
	"/articles": ArticlePage,
	"/pages": FixedPagePage,
	"/photos": PhotoLibraryPage,
	"/albums": AlbumWorkspacePage,
	"/review": ReviewQueuePage,
	"/media": MediaPage,
};
