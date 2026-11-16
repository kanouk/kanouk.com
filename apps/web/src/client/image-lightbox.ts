import { lightboxLinkLabel, PHOTO_SITE_LABEL } from "../utils/image-lightbox-link.mjs";
import { lightboxNeighbours, needsScrollIntoView, swipeStep } from "../utils/image-lightbox-nav.mjs";

/**
 * Every body image opens the same dialog. A linked image stays a real link, so
 * modified clicks open it as usual, and the dialog offers the link below the photo.
 * The photos of one article can be stepped through with the arrows, ← / → or a swipe.
 * The dialog is built on first use; only the photo being shown loads its larger file.
 */
let dialog: HTMLDialogElement | undefined;
let triggers: HTMLElement[] = [];
let current = -1;

const arrow = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

function lightbox(): HTMLDialogElement {
	if (dialog) return dialog;
	const box = document.createElement("dialog");
	dialog = box;
	box.className = "image-lightbox";
	box.setAttribute("aria-label", "拡大した写真");
	box.innerHTML = `
		<div class="image-lightbox__bar">
			<p class="image-lightbox__counter" aria-live="polite"></p>
			<form method="dialog"><button class="image-lightbox__close" aria-label="閉じる" autofocus>
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
			</button></form>
		</div>
		<div class="image-lightbox__stage">
			<div class="image-lightbox__frame">
				<div class="image-lightbox__photo"></div>
				<p class="image-lightbox__caption"></p>
				<a class="image-lightbox__link"><svg class="image-lightbox__link-site" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16"/><path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2"/><circle cx="13" cy="7" r="1" fill="currentColor"/><rect x="8" y="2" width="14" height="14" rx="2"/></svg><span></span><svg class="image-lightbox__link-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path/></svg></a>
			</div>
		</div>
		<button type="button" class="image-lightbox__nav image-lightbox__nav--previous" aria-label="前の写真" data-step="-1">${arrow("M15 5l-7 7 7 7")}</button>
		<button type="button" class="image-lightbox__nav image-lightbox__nav--next" aria-label="次の写真" data-step="1">${arrow("M9 5l7 7-7 7")}</button>`;

	let swiped = false;
	box.addEventListener("click", (event) => {
		const target = event.target as Element;
		// A swipe that ended on the photo is not also a tap.
		if (swiped) { swiped = false; return; }
		const nav = target.closest<HTMLElement>(".image-lightbox__nav");
		if (nav) { step(Number(nav.dataset.step)); return; }
		// Without a pointer to hover, tapping the photo shows and hides its caption.
		if (target.closest("img") && matchMedia("(hover: none)").matches) {
			box.querySelector(".image-lightbox__frame")?.classList.toggle("is-caption-shown");
		}
		// Clicks on the empty area around the image close it, as on the backdrop.
		if (!target.closest("img, a, button, .image-lightbox__counter")) box.close();
	});
	box.addEventListener("keydown", (event) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		if (delta && step(delta)) event.preventDefault();
	});

	// One-finger horizontal swipes step; pinches, pinch-zoomed views and vertical drags are left alone.
	const stage = box.querySelector<HTMLElement>(".image-lightbox__stage")!;
	let start: { x: number; y: number } | null = null;
	stage.addEventListener("touchstart", (event) => {
		const zoomed = (window.visualViewport?.scale ?? 1) > 1.01;
		start = event.touches.length === 1 && !zoomed ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
	}, { passive: true });
	stage.addEventListener("touchmove", (event) => { if (event.touches.length > 1) start = null; }, { passive: true });
	stage.addEventListener("touchend", (event) => {
		const touch = event.changedTouches[0];
		if (!start || !touch || event.touches.length) { start = null; return; }
		const delta = swipeStep(touch.clientX - start.x, touch.clientY - start.y);
		start = null;
		if (delta && step(delta)) {
			swiped = true;
			setTimeout(() => { swiped = false; }, 400);
		}
	});

	// Leave the page where the last photo viewed is, and give focus back to it.
	box.addEventListener("close", () => {
		const trigger = triggers[current];
		triggers = [];
		current = -1;
		if (!trigger?.isConnected) return;
		const rect = (trigger.querySelector("img") ?? trigger).getBoundingClientRect();
		if (needsScrollIntoView(rect.top, rect.bottom, innerHeight)) {
			const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
			trigger.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
		}
		trigger.focus({ preventScroll: true });
	});
	document.body.append(box);
	return box;
}

function enlargedImage(trigger: Element): Element | null {
	const shown = trigger.querySelector("img");
	if (!shown) return null;
	const copy = (trigger.querySelector("picture") ?? shown).cloneNode(true) as HTMLElement;
	copy.removeAttribute("style");
	copy.removeAttribute("data-reserve-space");
	for (const source of copy.querySelectorAll("source")) source.sizes = "100vw";
	const image = copy instanceof HTMLImageElement ? copy : copy.querySelector("img");
	if (!image) return null;
	// The article's own frame styles stay behind; the lightbox gives every photo the same mount.
	image.removeAttribute("class");
	// Show the file already on screen until the larger one arrives.
	image.style.backgroundImage = `url("${shown.currentSrc || shown.src}")`;
	image.addEventListener("load", () => { image.style.backgroundImage = ""; }, { once: true });
	image.sizes = "100vw";
	image.loading = "eager";
	image.removeAttribute("fetchpriority");
	return copy;
}

/** Puts the photo of `trigger` in the dialog with its caption and link. */
function show(box: HTMLDialogElement, trigger: HTMLElement): boolean {
	const content = enlargedImage(trigger);
	if (!content) return false;
	box.querySelector(".image-lightbox__photo")?.replaceChildren(content);

	const frame = box.querySelector<HTMLElement>(".image-lightbox__frame");
	const shown = trigger.querySelector("img");
	const width = Number(shown?.getAttribute("width")) || shown?.naturalWidth;
	const height = Number(shown?.getAttribute("height")) || shown?.naturalHeight;
	frame?.classList.remove("is-caption-shown");
	frame?.style.setProperty("--lightbox-width", width ? `${width}px` : "");
	frame?.style.setProperty("--lightbox-ratio", width && height ? String(width / height) : "");

	const caption = box.querySelector<HTMLElement>(".image-lightbox__caption");
	const text = trigger.closest("figure")?.querySelector("figcaption")?.textContent?.trim() ?? "";
	if (caption) {
		caption.textContent = text;
		caption.hidden = !text;
		frame?.toggleAttribute("tabindex", false);
		if (text) frame?.setAttribute("tabindex", "0");
	}

	const link = box.querySelector<HTMLAnchorElement>(".image-lightbox__link");
	if (link) {
		const href = trigger instanceof HTMLAnchorElement ? trigger.getAttribute("href") : null;
		link.hidden = !href;
		if (trigger instanceof HTMLAnchorElement && href) {
			const external = trigger.target === "_blank";
			link.href = href;
			link.target = trigger.target;
			link.rel = trigger.rel;
			const label = lightboxLinkLabel(trigger.href, location.origin);
			link.querySelector("span")!.textContent = label;
			link.querySelector(".image-lightbox__link-site")!.toggleAttribute("hidden", label !== PHOTO_SITE_LABEL);
			link.querySelector(".image-lightbox__link-arrow path")!.setAttribute("d", external ? "M7 17 17 7M8 7h9v9" : "M5 12h14M13 6l6 6-6 6");
		}
	}
	return true;
}

/** Shows the arrows and counter that fit the current photo. */
function updateNav(box: HTMLDialogElement) {
	const { previous, next, counter } = lightboxNeighbours(current, triggers.length);
	box.classList.toggle("has-nav", triggers.length > 1);
	const counterEl = box.querySelector<HTMLElement>(".image-lightbox__counter")!;
	counterEl.textContent = counter;
	counterEl.hidden = !counter;
	const previousButton = box.querySelector<HTMLButtonElement>(".image-lightbox__nav--previous")!;
	const nextButton = box.querySelector<HTMLButtonElement>(".image-lightbox__nav--next")!;
	previousButton.hidden = previous === null;
	nextButton.hidden = next === null;
	// An arrow that just hid must not take the keyboard focus with it.
	const active = document.activeElement;
	if (active instanceof HTMLButtonElement && active.hidden) {
		const other = active === previousButton ? nextButton : previousButton;
		(other.hidden ? box.querySelector<HTMLElement>(".image-lightbox__close") : other)?.focus();
	}
}

function step(delta: number): boolean {
	if (!dialog?.open || !delta) return false;
	const { previous, next } = lightboxNeighbours(current, triggers.length);
	const target = delta < 0 ? previous : next;
	if (target === null || !show(dialog, triggers[target])) return false;
	current = target;
	updateNav(dialog);
	return true;
}

function open(trigger: HTMLElement): boolean {
	const box = lightbox();
	if (!show(box, trigger)) return false;
	const scope = trigger.closest("article") ?? document;
	triggers = [...scope.querySelectorAll<HTMLElement>("[data-image-lightbox]")].filter((el) => el.querySelector("img"));
	current = triggers.indexOf(trigger);
	if (current < 0) { triggers = [trigger]; current = 0; }
	updateNav(box);
	box.showModal();
	return true;
}

document.addEventListener("click", (event) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const trigger = (event.target as Element).closest<HTMLElement>("[data-image-lightbox]");
	if (trigger && open(trigger)) event.preventDefault();
});
