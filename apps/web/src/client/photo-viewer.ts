/**
 * The full-screen photo viewer on /p/[slug].
 *
 * Moving to another photo does not reload the page: the neighbouring photo
 * pages (server-rendered and edge-cached) are fetched ahead of time, their
 * image is placed beside the current one, and the parts of the page marked
 * data-viewer-part are swapped in once the slide finishes. The URL follows
 * along with history.replaceState, so Back still returns to the album.
 *
 * Touch: swipe sideways to move, swipe down to close, pinch or double-tap to
 * zoom, drag to pan while zoomed, tap to hide or show the controls.
 */
import { mountAdminBar } from "./admin-bar";
import { loadMapStyle } from "./map-style";
import { albumPhotoAnchor, photoReturnKey, readPhotoReturn } from "../utils/photo-return.mjs";

type Direction = "previous" | "next";
type Point = { x: number; y: number };

const SLIDE_GAP = 24;
const SLIDE_MS = 280;
const SLIDESHOW_MS = 6000;
const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const SPINNER_DELAY_MS = 150;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const absolute = (url: string) => new URL(url, window.location.href).href;

export function mountPhotoViewer(): void {
	const root = document.querySelector<HTMLElement>("[data-photo-viewer]");
	const stage = root?.querySelector<HTMLElement>("[data-viewer-stage]");
	const track = root?.querySelector<HTMLElement>("[data-viewer-track]");
	if (!root || !stage || !track) return;

	const slide = (name: Direction | "current") => track.querySelector<HTMLElement>(`[data-viewer-slide="${name}"]`)!;
	const status = root.querySelector<HTMLElement>(".photo-tool-status");
	const announce = (message: string) => { if (status) status.textContent = message; };
	const neighbourUrl = (direction: Direction) => direction === "previous" ? root.dataset.previousUrl : root.dataset.nextUrl;
	const returnLink = () => root.querySelector<HTMLAnchorElement>("[data-photo-return]");

	slide("current").dataset.url = absolute(window.location.pathname);

	// ---- Fetching neighbouring pages ---------------------------------------

	const pages = new Map<string, Promise<Document>>();
	const fetchPage = (url: string) => {
		const key = absolute(url);
		let page = pages.get(key);
		if (!page) {
			page = fetch(key, { credentials: "same-origin", headers: { Accept: "text/html" } })
				.then((response) => {
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return response.text();
				})
				.then((html) => new DOMParser().parseFromString(html, "text/html"));
			page.catch(() => pages.delete(key));
			pages.set(key, page);
		}
		return page;
	};

	/** Put the photo of `url` into the neighbouring slide, ready to slide in. */
	const fillSlide = async (direction: Direction, url = neighbourUrl(direction)) => {
		const target = slide(direction);
		const key = url ? absolute(url) : "";
		if (target.dataset.url === key && (target.firstElementChild || !key)) return;
		target.dataset.url = key;
		target.replaceChildren();
		if (!key) return;
		const page = await fetchPage(key);
		const frame = page.querySelector('[data-viewer-slide="current"] .photo-media-frame');
		if (!frame || target.dataset.url !== key) return;
		const copy = document.importNode(frame, true) as HTMLElement;
		copy.querySelectorAll("img").forEach((image) => { image.loading = "eager"; image.removeAttribute("fetchpriority"); });
		copy.querySelectorAll("video").forEach((video) => { video.preload = "none"; });
		target.replaceChildren(copy);
	};
	const prepareNeighbours = () => {
		void fillSlide("previous").catch(() => undefined);
		void fillSlide("next").catch(() => undefined);
	};

	// ---- Zoom ----------------------------------------------------------------

	const zoom = { scale: 1, x: 0, y: 0 };
	const frame = () => slide("current").querySelector<HTMLElement>(".photo-media-frame");
	const media = () => frame()?.querySelector<HTMLElement>("img, video") ?? null;
	const zoomable = () => media()?.tagName === "IMG";
	const applyZoom = (animate: boolean) => {
		const element = frame();
		if (!element) return;
		element.style.transition = animate && !reducedMotion() ? "transform 220ms cubic-bezier(.2,.7,.2,1)" : "none";
		element.style.transform = zoom.scale === 1 && !zoom.x && !zoom.y
			? ""
			: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`;
		root.classList.toggle("is-zoomed", zoom.scale > 1);
	};
	const clampPan = () => {
		const element = media();
		if (!element) return;
		const maxX = Math.max(0, (element.offsetWidth * zoom.scale - stage.clientWidth) / 2);
		const maxY = Math.max(0, (element.offsetHeight * zoom.scale - stage.clientHeight) / 2);
		zoom.x = clamp(zoom.x, -maxX, maxX);
		zoom.y = clamp(zoom.y, -maxY, maxY);
	};
	const resetZoom = (animate = true) => {
		if (zoom.scale === 1 && !zoom.x && !zoom.y) return;
		zoom.scale = 1; zoom.x = 0; zoom.y = 0;
		applyZoom(animate);
	};
	/** Offset of a client point from the stage centre, where the frame is centred. */
	const fromCentre = (x: number, y: number): Point => {
		const box = stage.getBoundingClientRect();
		return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
	};
	/** Zoom to `scale` keeping the point `at` (from the centre) still. */
	const zoomTo = (scale: number, at: Point, animate: boolean) => {
		const next = clamp(scale, 1, MAX_ZOOM);
		zoom.x = at.x - (at.x - zoom.x) * (next / zoom.scale);
		zoom.y = at.y - (at.y - zoom.y) * (next / zoom.scale);
		zoom.scale = next;
		if (next === 1) { zoom.x = 0; zoom.y = 0; }
		clampPan();
		applyZoom(animate);
	};
	const toggleZoom = (x: number, y: number) => {
		if (!zoomable()) return;
		if (zoom.scale > 1) resetZoom();
		else zoomTo(DOUBLE_TAP_ZOOM, fromCentre(x, y), true);
	};

	// ---- Moving between photos -----------------------------------------------

	let busy = false;
	const setTrack = (offset: number, animate: boolean) => {
		track.style.transition = animate && !reducedMotion() ? `transform ${SLIDE_MS}ms cubic-bezier(.22,.7,.2,1)` : "none";
		track.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
	};
	const settleTrack = async (offset: number) => {
		setTrack(offset, true);
		if (!reducedMotion()) await wait(SLIDE_MS + 20);
	};

	/** After sliding, the incoming slide becomes the current one; the outgoing far slide is reused. */
	const rotate = (direction: Direction) => {
		const outgoing = slide(direction === "next" ? "previous" : "next");
		const current = slide("current");
		const incoming = slide(direction);
		setTrack(0, false);
		outgoing.dataset.viewerSlide = direction;
		outgoing.replaceChildren();
		outgoing.dataset.url = "";
		current.dataset.viewerSlide = direction === "next" ? "previous" : "next";
		incoming.dataset.viewerSlide = "current";
		for (const element of [outgoing, current]) {
			element.setAttribute("aria-hidden", "true");
			element.inert = true;
			element.querySelector<HTMLElement>(".photo-media-frame")?.style.removeProperty("transform");
			element.querySelector("video")?.pause();
		}
		incoming.removeAttribute("aria-hidden");
		incoming.inert = false;
	};

	let map: { remove(): void } | undefined;
	/** Take over the new photo's title, links and panels from its server-rendered page. */
	const applyPage = (page: Document, url: string) => {
		const incoming = page.querySelector<HTMLElement>("[data-photo-viewer]");
		if (!incoming) throw new Error("photo viewer markup missing");
		for (const key of ["photoId", "previousUrl", "nextUrl", "slideshowNextUrl", "albumId"]) {
			const value = incoming.dataset[key];
			if (value === undefined) delete root.dataset[key];
			else root.dataset[key] = value;
		}
		map?.remove();
		map = undefined;
		root.querySelectorAll<HTMLElement>("[data-viewer-part]").forEach((part) => {
			const fresh = incoming.querySelector(`[data-viewer-part="${part.dataset.viewerPart}"]`);
			if (fresh) part.replaceWith(document.importNode(fresh, true));
		});
		for (const direction of ["previous", "next"] as const) {
			const link = root.querySelector<HTMLAnchorElement>(`.media-navigation--${direction}`);
			const href = neighbourUrl(direction);
			if (!link) continue;
			link.hidden = !href;
			if (href) link.href = href;
			else link.removeAttribute("href");
		}
		document.title = page.title;
		for (const selector of ['link[rel="canonical"]', 'meta[name="description"]', 'meta[property="og:url"]', 'meta[property="og:title"]', 'meta[property="og:image"]']) {
			const current = document.head.querySelector(selector);
			const fresh = page.head.querySelector(selector);
			if (current && fresh) current.replaceWith(document.importNode(fresh, true));
		}
		for (const name of ["data-admin-collection", "data-admin-id", "data-admin-album"]) {
			const value = page.documentElement.getAttribute(name);
			if (value === null) document.documentElement.removeAttribute(name);
			else document.documentElement.setAttribute(name, value);
		}
		window.history.replaceState(window.history.state, "", url);
		rememberReturn();
		syncControls();
		if (infoOpen) openInfo(false);
		if (document.querySelector(".adminbar")) void mountAdminBar();
		const heading = root.querySelector("#photo-title")?.textContent || root.querySelector("[data-viewer-part=heading]")?.textContent || "";
		announce(`${root.querySelector(".photo-position")?.textContent ?? ""} ${heading}`.trim());
	};

	const go = async (direction: Direction, url = neighbourUrl(direction)) => {
		if (busy) return;
		if (!url) { await settleTrack(0); return; }
		busy = true;
		resetZoom(false);
		const spinner = window.setTimeout(() => root.classList.add("is-loading"), SPINNER_DELAY_MS);
		try {
			const page = await fetchPage(url);
			await fillSlide(direction, url);
			window.clearTimeout(spinner);
			root.classList.remove("is-loading");
			const width = stage.clientWidth + SLIDE_GAP;
			await settleTrack(direction === "next" ? -width : width);
			rotate(direction);
			applyPage(page, url);
			slide("current").dataset.url = absolute(url);
			prepareNeighbours();
		} catch {
			window.location.assign(url);
		} finally {
			window.clearTimeout(spinner);
			root.classList.remove("is-loading");
			busy = false;
		}
	};

	const close = () => {
		stopSlideshow(false);
		const link = returnLink();
		root.classList.add("is-closing");
		window.location.assign(link?.href ?? "/albums");
	};

	// ---- Return position in the album ----------------------------------------

	const rememberReturn = () => {
		const { albumId, photoId } = root.dataset;
		if (!albumId || !photoId) return;
		try {
			sessionStorage.setItem(photoReturnKey(albumId), JSON.stringify({ albumId, photoId, savedAt: Date.now() }));
		} catch { /* The close link carries the photo anyway. */ }
	};
	{
		// Arriving from the album: return to the tile that was opened, even after a reload.
		const link = returnLink();
		const albumId = root.dataset.albumId;
		if (link && albumId) {
			try {
				const returnId = readPhotoReturn(sessionStorage.getItem(photoReturnKey(albumId)), albumId);
				if (returnId) {
					const destination = new URL(link.href);
					destination.hash = albumPhotoAnchor(returnId);
					destination.searchParams.set("photo", returnId);
					link.href = destination.toString();
				}
			} catch { /* Fall back to the current photo's anchor. */ }
		}
	}

	// ---- Info panel ----------------------------------------------------------

	let infoOpen = false;
	const infoPanel = () => root.querySelector<HTMLElement>("[data-photo-info-panel]");
	const infoButton = () => root.querySelector<HTMLButtonElement>("[data-photo-info]");
	const loadMap = async () => {
		const canvas = infoPanel()?.querySelector<HTMLElement>("[data-photo-map]");
		if (!canvas || canvas.dataset.ready) return;
		canvas.dataset.ready = "true";
		const latitude = Number(canvas.dataset.latitude);
		const longitude = Number(canvas.dataset.longitude);
		try {
			const [{ default: L }] = await Promise.all([import("leaflet"), loadMapStyle()]);
			if (!canvas.isConnected) return;
			const instance = L.map(canvas, { scrollWheelZoom: false, attributionControl: false, zoomControl: true }).setView([latitude, longitude], 15);
			L.control.attribution({ prefix: false }).addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>').addTo(instance);
			L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(instance);
			L.circleMarker([latitude, longitude], { radius: 7, weight: 2, color: "#fff", fillColor: "#17658c", fillOpacity: 0.95 }).addTo(instance);
			map = instance;
		} catch {
			canvas.textContent = "地図を読み込めませんでした。";
		}
	};
	const openInfo = (focus: boolean) => {
		const panel = infoPanel();
		const button = infoButton();
		if (!panel) return;
		infoOpen = true;
		panel.hidden = false;
		root.classList.add("is-info-open");
		button?.setAttribute("aria-expanded", "true");
		button?.setAttribute("aria-label", "写真情報を閉じる");
		resetZoom(false);
		void loadMap();
		if (focus) panel.querySelector<HTMLElement>("[data-photo-info-close]")?.focus();
	};
	const closeInfo = (restoreFocus: boolean) => {
		const panel = infoPanel();
		const button = infoButton();
		infoOpen = false;
		if (panel) panel.hidden = true;
		root.classList.remove("is-info-open");
		button?.setAttribute("aria-expanded", "false");
		button?.setAttribute("aria-label", "写真情報を表示");
		if (restoreFocus) button?.focus();
	};

	// ---- Slideshow and other controls -----------------------------------------

	let slideshowTimer: number | undefined;
	const slideshowButton = () => root.querySelector<HTMLButtonElement>("[data-photo-slideshow]");
	const syncControls = () => {
		const button = slideshowButton();
		const playing = slideshowTimer !== undefined;
		button?.setAttribute("aria-pressed", String(playing));
		button?.setAttribute("aria-label", playing ? "スライドショーを停止" : "スライドショーを開始");
		const fullscreen = root.querySelector<HTMLButtonElement>("[data-photo-fullscreen]");
		if (fullscreen) fullscreen.hidden = !document.fullscreenEnabled;
	};
	const scheduleSlideshow = () => {
		slideshowTimer = window.setTimeout(async () => {
			const url = root.dataset.slideshowNextUrl;
			if (!url) { stopSlideshow(true); return; }
			await go("next", url);
			if (slideshowTimer !== undefined) scheduleSlideshow();
		}, SLIDESHOW_MS);
	};
	const startSlideshow = () => {
		if (!root.dataset.slideshowNextUrl) return;
		window.clearTimeout(slideshowTimer);
		scheduleSlideshow();
		syncControls();
		announce("6秒ごとに次の写真へ進みます");
	};
	function stopSlideshow(say: boolean) {
		if (slideshowTimer === undefined) return;
		window.clearTimeout(slideshowTimer);
		slideshowTimer = undefined;
		syncControls();
		const current = new URL(window.location.href);
		if (current.searchParams.has("slideshow")) {
			current.searchParams.delete("slideshow");
			window.history.replaceState(window.history.state, "", current);
		}
		if (say) announce("スライドショーを停止しました");
	}

	const share = async () => {
		try {
			const url = new URL(window.location.pathname, window.location.origin).toString();
			if (navigator.share) await navigator.share({ title: document.title, url });
			else {
				await navigator.clipboard.writeText(url);
				announce("URLをコピーしました");
			}
		} catch (error) {
			if ((error as DOMException).name !== "AbortError") announce("共有を開始できませんでした");
		}
	};

	root.addEventListener("click", (event) => {
		const target = event.target as Element;
		if (target.closest("[data-photo-info]")) { if (infoOpen) closeInfo(false); else openInfo(false); return; }
		if (target.closest("[data-photo-info-close]")) { closeInfo(true); return; }
		if (target.closest("[data-photo-share]")) { void share(); return; }
		if (target.closest("[data-photo-slideshow]")) { if (slideshowTimer === undefined) startSlideshow(); else stopSlideshow(true); return; }
		if (target.closest("[data-photo-fullscreen]")) {
			(document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen())
				.catch(() => announce("このブラウザでは全画面表示を開始できませんでした"));
			return;
		}
		if (target.closest("[data-photo-return]")) { stopSlideshow(false); return; }
		const arrow = target.closest<HTMLAnchorElement>(".media-navigation");
		if (arrow && !(event as MouseEvent).metaKey && !(event as MouseEvent).ctrlKey) {
			event.preventDefault();
			stopSlideshow(false);
			void go(arrow.classList.contains("media-navigation--previous") ? "previous" : "next");
		}
	});

	document.addEventListener("keydown", (event) => {
		const target = event.target as HTMLElement | null;
		if (event.key === "Escape") {
			if (zoom.scale > 1) { resetZoom(); return; }
			if (infoOpen) { closeInfo(true); return; }
			if (slideshowTimer !== undefined) { stopSlideshow(true); return; }
			if (document.fullscreenElement) return;
			if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
			event.preventDefault();
			close();
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		if (target?.closest("input, textarea, select, video, [contenteditable], .adminbar, .leaflet-container")) return;
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			stopSlideshow(false);
			void go(event.key === "ArrowLeft" ? "previous" : "next");
		}
	});

	// ---- Touch and pointer gestures -------------------------------------------

	type Gesture =
		| { kind: "pending" | "swipe" | "dismiss" | "pan"; start: Point; origin: Point; last: Point & { t: number }; velocity: Point; startedAt: number }
		| { kind: "pinch"; distance: number; mid: Point; scale: number; origin: Point }
		| { kind: "none" };
	const pointers = new Map<number, Point>();
	let gesture: Gesture = { kind: "none" };
	let lastTap: (Point & { t: number }) | undefined;
	let tapTimer: number | undefined;
	let lastPointerType = "mouse";

	const spread = () => {
		const [a, b] = [...pointers.values()];
		return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2) };
	};
	const setDismiss = (distance: number, animate: boolean) => {
		const element = frame();
		root.style.setProperty("--viewer-dismiss", String(clamp(distance / 320, 0, 1)));
		root.classList.toggle("is-dismissing", distance > 0);
		if (!element) return;
		element.style.transition = animate && !reducedMotion() ? "transform 220ms cubic-bezier(.2,.7,.2,1)" : "none";
		element.style.transform = distance ? `translate3d(0, ${distance}px, 0) scale(${1 - clamp(distance / 1600, 0, 0.18)})` : "";
	};

	stage.addEventListener("pointerdown", (event) => {
		lastPointerType = event.pointerType;
		if (busy || (event.target as Element).closest("video, a, button")) return;
		if (event.pointerType === "mouse" && (event.button !== 0 || zoom.scale === 1)) return;
		// A new primary pointer starts a new gesture: forget touches whose end was never reported.
		if (event.isPrimary) pointers.clear();
		try { stage.setPointerCapture(event.pointerId); } catch { /* synthetic pointers */ }
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		stopSlideshow(false);
		if (pointers.size === 2 && zoomable()) {
			setTrack(0, true);
			setDismiss(0, true);
			const { distance, mid } = spread();
			gesture = { kind: "pinch", distance, mid, scale: zoom.scale, origin: { x: zoom.x, y: zoom.y } };
			window.clearTimeout(tapTimer);
			lastTap = undefined;
			return;
		}
		if (pointers.size > 1) return;
		const now = performance.now();
		const point = { x: event.clientX, y: event.clientY };
		gesture = {
			kind: zoom.scale > 1 ? "pan" : "pending",
			start: point,
			origin: { x: zoom.x, y: zoom.y },
			last: { ...point, t: now },
			velocity: { x: 0, y: 0 },
			startedAt: now,
		};
	});

	stage.addEventListener("pointermove", (event) => {
		if (!pointers.has(event.pointerId)) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (gesture.kind === "pinch") {
			if (pointers.size < 2) return;
			const { distance, mid } = spread();
			const scale = clamp(gesture.scale * (distance / gesture.distance), 0.85, MAX_ZOOM + 0.5);
			zoom.x = mid.x - (gesture.mid.x - gesture.origin.x) * (scale / gesture.scale);
			zoom.y = mid.y - (gesture.mid.y - gesture.origin.y) * (scale / gesture.scale);
			zoom.scale = scale;
			applyZoom(false);
			return;
		}
		if (gesture.kind === "none") return;
		const now = performance.now();
		const dx = event.clientX - gesture.start.x;
		const dy = event.clientY - gesture.start.y;
		const elapsed = Math.max(1, now - gesture.last.t);
		gesture.velocity = { x: (event.clientX - gesture.last.x) / elapsed, y: (event.clientY - gesture.last.y) / elapsed };
		gesture.last = { x: event.clientX, y: event.clientY, t: now };
		if (gesture.kind === "pending") {
			if (Math.hypot(dx, dy) < 8) return;
			if (event.pointerType === "mouse" || (Math.abs(dx) <= Math.abs(dy) && dy <= 0)) { gesture = { kind: "none" }; return; }
			gesture.kind = Math.abs(dx) > Math.abs(dy) ? "swipe" : "dismiss";
		}
		if (gesture.kind === "swipe") {
			const blocked = (dx > 0 && !root.dataset.previousUrl) || (dx < 0 && !root.dataset.nextUrl);
			setTrack(blocked ? dx * 0.3 : dx, false);
		} else if (gesture.kind === "dismiss") {
			setDismiss(Math.max(0, dy), false);
		} else if (gesture.kind === "pan") {
			zoom.x = gesture.origin.x + dx;
			zoom.y = gesture.origin.y + dy;
			clampPan();
			applyZoom(false);
		}
	});

	const endPointer = (event: PointerEvent) => {
		if (!pointers.has(event.pointerId)) return;
		const start = pointers.get(event.pointerId)!;
		pointers.delete(event.pointerId);
		if (gesture.kind === "pinch") {
			if (pointers.size > 0) return;
			gesture = { kind: "none" };
			if (zoom.scale <= 1.02) resetZoom();
			else { zoom.scale = clamp(zoom.scale, 1, MAX_ZOOM); clampPan(); applyZoom(true); }
			return;
		}
		const current = gesture;
		gesture = { kind: "none" };
		if (current.kind === "none") return;
		const dx = event.clientX - current.start.x;
		const dy = event.clientY - current.start.y;
		const cancelled = event.type === "pointercancel";
		if (current.kind === "swipe") {
			const threshold = stage.clientWidth * 0.18;
			if (!cancelled && (dx < -threshold || current.velocity.x < -0.45) && root.dataset.nextUrl) void go("next");
			else if (!cancelled && (dx > threshold || current.velocity.x > 0.45) && root.dataset.previousUrl) void go("previous");
			else void settleTrack(0);
			return;
		}
		if (current.kind === "dismiss") {
			if (!cancelled && (dy > 120 || current.velocity.y > 0.6)) close();
			else setDismiss(0, true);
			return;
		}
		if (current.kind === "pan") { clampPan(); applyZoom(true); }
		// A short touch without movement is a tap: double-tap zooms, a single tap shows or hides the controls.
		const moved = Math.hypot(start.x - current.start.x, start.y - current.start.y);
		if (cancelled || event.pointerType === "mouse" || moved > 10 || performance.now() - current.startedAt > 300) return;
		const now = performance.now();
		if (lastTap && now - lastTap.t < 320 && Math.hypot(lastTap.x - start.x, lastTap.y - start.y) < 40) {
			window.clearTimeout(tapTimer);
			lastTap = undefined;
			toggleZoom(start.x, start.y);
			return;
		}
		lastTap = { ...start, t: now };
		tapTimer = window.setTimeout(() => {
			lastTap = undefined;
			root.classList.toggle("is-chrome-hidden");
		}, 320);
	};
	stage.addEventListener("pointerup", endPointer);
	stage.addEventListener("pointercancel", endPointer);
	stage.addEventListener("dblclick", (event) => {
		// Touch double-taps are handled above; browsers also report them as dblclick.
		if (lastPointerType !== "mouse" || (event.target as Element).closest("video, a, button")) return;
		toggleZoom(event.clientX, event.clientY);
	});
	// Trackpad pinch arrives as ctrl+wheel.
	stage.addEventListener("wheel", (event) => {
		if (!event.ctrlKey || !zoomable()) return;
		event.preventDefault();
		zoomTo(zoom.scale * Math.exp(-event.deltaY * 0.01), fromCentre(event.clientX, event.clientY), false);
	}, { passive: false });

	window.addEventListener("resize", () => {
		setTrack(0, false);
		clampPan();
		applyZoom(false);
	});
	// Coming back with the browser's Back/Forward cache: drop half-finished gestures.
	window.addEventListener("pageshow", () => {
		root.classList.remove("is-closing", "is-dismissing");
		setDismiss(0, false);
	});

	syncControls();
	prepareNeighbours();
	if (new URL(window.location.href).searchParams.get("slideshow") === "1") startSlideshow();
}
