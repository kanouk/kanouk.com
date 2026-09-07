import type { LinkPreviewAutoSnapshot } from "./link-preview.ts";
import type { PublicLinkPreviewResult } from "./public-link-preview.ts";

const SELECTOR = "a[data-yohaku-link-preview]";
const OWN_HOSTS = new Set([
	"blog.kanouk.com", "blog-staging.kanouk.com", "photos.kanouk.com", "photos-staging.kanouk.com",
	"kanouk-emdash-staging.kanouk.workers.dev", "kanolog.net", "www.kanolog.net",
	"nocalog.net", "www.nocalog.net", "art-quiz.com", "www.art-quiz.com",
]);

function validSnapshot(value: unknown): value is LinkPreviewAutoSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<LinkPreviewAutoSnapshot>;
	return candidate.version === 1 &&
		[candidate.url, candidate.title, candidate.description, candidate.imageUrl, candidate.fetchedAt]
			.every((field) => typeof field === "string");
}

function safeImageUrl(value: string, allowOwnHost: boolean): string {
	try {
		const image = new URL(value);
		if (image.protocol !== "https:" || image.username || image.password || image.port) return "";
		if (!allowOwnHost && OWN_HOSTS.has(image.hostname.toLowerCase())) return "";
		return image.href;
	} catch {
		return "";
	}
}

function setImage(card: HTMLAnchorElement, imageUrl: string) {
	const existing = card.querySelector<HTMLElement>(":scope > .yohaku-link-card__thumb");
	if (!imageUrl) {
		if (existing) existing.hidden = true;
		card.classList.add("has-no-image");
		return;
	}
	const thumb = existing;
	if (!thumb) return;
	thumb.hidden = false;
	let image = thumb.querySelector("img");
	if (!image) {
		return;
	}
	image.src = imageUrl;
	card.classList.remove("has-no-image");
}

export function applyPublicLinkPreview(card: HTMLAnchorElement, result: PublicLinkPreviewResult): void {
	const metadata = "metadata" in result && validSnapshot(result.metadata) ? result.metadata : null;
	const clearAuto = result.authoritative && !metadata;
	const fallback = card.dataset.fallbackTitle || card.href;
	if (card.dataset.manualTitle !== "true") {
		const title = card.querySelector<HTMLElement>("[data-link-preview-title]");
		if (title && (metadata || clearAuto)) title.textContent = metadata?.title || fallback;
	}
	if (card.dataset.manualDescription !== "true") {
		const description = card.querySelector<HTMLElement>("[data-link-preview-description]");
		const value = metadata?.description || "";
		if (value && description) {
			description.textContent = value;
			description.hidden = false;
		} else if (metadata || clearAuto) {
			if (description) {
				description.textContent = "";
				description.hidden = true;
			}
		}
	}
	if (card.dataset.manualImage !== "true") {
		const imageUrl = metadata ? safeImageUrl(metadata.imageUrl, result.authoritative) : "";
		if (metadata || clearAuto) setImage(card, imageUrl);
	}
}

async function refresh(card: HTMLAnchorElement, deadline = Date.now() + 15_000): Promise<void> {
	const { collection, entryId, blockKey } = card.dataset;
	if (!collection || !entryId || !blockKey) return;
	const query = new URLSearchParams({ collection, entryId, blockKey });
	try {
		const response = await fetch(`/_yohaku/link-preview?${query}`, {
			method: "GET",
			credentials: "omit",
			cache: "no-store",
			headers: { Accept: "application/json" },
			referrerPolicy: "same-origin",
		});
		if (!response.ok) return;
		const result = await response.json() as PublicLinkPreviewResult;
		applyPublicLinkPreview(card, result);
		if (result.state === "pending") {
			const retryAfter = Math.min(5_000, Math.max(500, result.retryAfterMs ?? 1_500));
			if (Date.now() + retryAfter <= deadline) setTimeout(() => void refresh(card, deadline), retryAfter);
		}
	} catch {
		// The original anchor and its saved fallback remain fully usable offline.
	}
}

if (typeof document !== "undefined") {
	for (const card of document.querySelectorAll<HTMLAnchorElement>(SELECTOR)) {
		if (card.dataset.linkPreviewStarted === "true") continue;
		card.dataset.linkPreviewStarted = "true";
		void refresh(card);
	}
}
