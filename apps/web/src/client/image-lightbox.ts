import { lightboxLinkLabel, PHOTO_SITE_LABEL } from "../utils/image-lightbox-link.mjs";

/**
 * Every body image opens the same dialog. A linked image stays a real link, so
 * modified clicks open it as usual, and the dialog offers the link below the photo.
 * The dialog is built on first use; the larger file loads only when opened.
 */
let dialog: HTMLDialogElement | undefined;

function lightbox(): HTMLDialogElement {
	if (dialog) return dialog;
	dialog = document.createElement("dialog");
	dialog.className = "image-lightbox";
	dialog.setAttribute("aria-label", "拡大した写真");
	dialog.innerHTML = `
		<div class="image-lightbox__bar">
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
		</div>`;
	// Clicks on the empty area around the image close it, as on the backdrop.
	dialog.addEventListener("click", (event) => {
		const target = event.target as Element;
		// Without a pointer to hover, tapping the photo shows and hides its caption.
		if (target.closest("img") && matchMedia("(hover: none)").matches) {
			dialog?.querySelector(".image-lightbox__frame")?.classList.toggle("is-caption-shown");
		}
		if (!target.closest("img, a")) dialog?.close();
	});
	document.body.append(dialog);
	return dialog;
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
	box.showModal();
	return true;
}

document.addEventListener("click", (event) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const trigger = (event.target as Element).closest<HTMLElement>("[data-image-lightbox]");
	if (trigger && open(trigger)) event.preventDefault();
});
