import { lightboxLinkLabel } from "../utils/image-lightbox-link.mjs";

/**
 * Every body image opens the same dialog. A linked image stays a real link, so
 * modified clicks open it as usual, and the dialog offers the link underneath.
 * The dialog is built on first use; the larger file loads only when opened.
 */
let dialog: HTMLDialogElement | undefined;

function lightbox(): HTMLDialogElement {
	if (dialog) return dialog;
	dialog = document.createElement("dialog");
	dialog.className = "image-lightbox";
	dialog.setAttribute("aria-label", "拡大した写真");
	dialog.innerHTML = `
		<form method="dialog" class="image-lightbox__bar">
			<button class="image-lightbox__close" aria-label="閉じる">
				<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
			</button>
		</form>
		<div class="image-lightbox__stage"></div>
		<div class="image-lightbox__meta">
			<p class="image-lightbox__caption"></p>
			<a class="image-lightbox__link"></a>
		</div>`;
	// Clicks on the empty area around the image close it, as on the backdrop.
	dialog.addEventListener("click", (event) => {
		const target = event.target as Element;
		if (!target.closest("img, a, p")) dialog?.close();
	});
	dialog.addEventListener("close", () => {
		dialog?.querySelector(".image-lightbox__stage")?.replaceChildren();
	});
	document.body.append(dialog);
	return dialog;
}

function enlargedImage(trigger: Element): Element | null {
	const shown = trigger.querySelector("img");
	if (!shown) return null;
	const copy = (trigger.querySelector("picture") ?? shown).cloneNode(true) as HTMLElement;
	copy.removeAttribute("style");
	for (const source of copy.querySelectorAll("source")) source.sizes = "100vw";
	const image = copy instanceof HTMLImageElement ? copy : copy.querySelector("img");
	if (!image) return null;
	// Show the file already on screen until the larger one arrives.
	image.style.backgroundImage = `url("${shown.currentSrc || shown.src}")`;
	image.addEventListener("load", () => { image.style.backgroundImage = ""; }, { once: true });
	image.sizes = "100vw";
	image.loading = "eager";
	image.removeAttribute("fetchpriority");
	return copy;
}

function open(trigger: HTMLElement): boolean {
	const content = enlargedImage(trigger);
	if (!content) return false;
	const box = lightbox();
	box.querySelector(".image-lightbox__stage")?.replaceChildren(content);

	const caption = box.querySelector<HTMLElement>(".image-lightbox__caption");
	const text = trigger.closest("figure")?.querySelector("figcaption")?.textContent?.trim() ?? "";
	if (caption) {
		caption.textContent = text;
		caption.hidden = !text;
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
			link.textContent = `${lightboxLinkLabel(trigger.href, location.origin)} ${external ? "↗" : "→"}`;
		}
	}
	box.showModal();
	return true;
}

document.addEventListener("click", (event) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const trigger = (event.target as Element).closest<HTMLElement>("[data-image-lightbox]");
	if (trigger && open(trigger)) event.preventDefault();
});
