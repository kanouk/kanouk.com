/**
 * The admin bar on the public sites.
 *
 * Public pages are served from Cloudflare's shared cache, so the HTML can never
 * depend on who is signed in. Instead, a readable marker cookie says "an admin
 * uses this browser": a tiny inline script reserves the bar's height before
 * paint, and this module fetches the bar from an uncached endpoint and inserts
 * it. On the blog that endpoint checks the real session; on the photo site it
 * cannot, but every link still needs the blog's login.
 */

export const ADMIN_BAR_COOKIE = "kanouk-admin-bar";
const SESSION_SYNC = "kanouk-admin-bar-synced";

const PHOTO_ORIGIN_FOR: Record<string, string> = {
	"blog.kanouk.com": "https://photos.kanouk.com",
	"blog-staging.kanouk.com": "https://photos-staging.kanouk.com",
};

function writeMarker(on: boolean): void {
	const secure = location.protocol === "https:" ? "; Secure" : "";
	document.cookie = on
		? `${ADMIN_BAR_COOKIE}=1; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`
		: `${ADMIN_BAR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

/** Ask the photo site (same site, other host) to set or clear its own marker. */
function markPhotoSite(state: "on" | "off"): Promise<unknown> {
	const origin = PHOTO_ORIGIN_FOR[location.hostname];
	if (!origin) return Promise.resolve();
	return fetch(`${origin}/admin-bar?state=${state}`, { mode: "no-cors", credentials: "include" }).catch(() => undefined);
}

/** Called by the admin (which is never cached and always signed in). */
export function markAdminPresent(): void {
	writeMarker(true);
	try {
		if (sessionStorage.getItem(SESSION_SYNC)) return;
		void markPhotoSite("on").then(() => sessionStorage.setItem(SESSION_SYNC, "1"));
	} catch {
		void markPhotoSite("on");
	}
}

function bind(bar: HTMLElement): void {
	const menus = () => [...bar.querySelectorAll<HTMLDetailsElement>("details.adminbar__menu")];
	// One menu open at a time; a click elsewhere or Escape closes it.
	bar.addEventListener("toggle", (event) => {
		const opened = event.target as HTMLDetailsElement;
		if (opened.open) for (const menu of menus()) if (menu !== opened) menu.open = false;
	}, true);
	document.addEventListener("click", (event) => {
		if (!bar.contains(event.target as Node)) for (const menu of menus()) menu.open = false;
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		const open = menus().find((menu) => menu.open);
		if (!open) return;
		open.open = false;
		open.querySelector<HTMLElement>("summary")?.focus();
	});
	bar.querySelector<HTMLButtonElement>("[data-adminbar-hide]")?.addEventListener("click", async (event) => {
		(event.currentTarget as HTMLButtonElement).disabled = true;
		await fetch("/admin-bar?state=off", { credentials: "same-origin" }).catch(() => undefined);
		writeMarker(false);
		window.location.reload();
	});
	bar.querySelector<HTMLButtonElement>("[data-adminbar-logout]")?.addEventListener("click", async (event) => {
		(event.currentTarget as HTMLButtonElement).disabled = true;
		writeMarker(false);
		try { sessionStorage.removeItem(SESSION_SYNC); } catch { /* storage unavailable */ }
		await markPhotoSite("off");
		try {
			// The API requires this header on state-changing requests.
			await fetch("/_emdash/api/auth/logout", {
				method: "POST",
				credentials: "same-origin",
				headers: { "X-EmDash-Request": "1" },
			});
		} finally {
			window.location.assign(window.location.pathname);
		}
	});
}

/** Fetch and insert the bar when the marker reserved its space. */
export async function mountAdminBar(): Promise<void> {
	const root = document.documentElement;
	if (!root.classList.contains("has-admin-bar")) return;
	const params = new URLSearchParams({ site: root.dataset.adminSite ?? "blog" });
	for (const [key, value] of [["collection", root.dataset.adminCollection], ["id", root.dataset.adminId], ["album", root.dataset.adminAlbum]]) {
		if (value) params.set(key!, value);
	}
	const release = () => root.classList.remove("has-admin-bar");
	try {
		const response = await fetch(`/admin-bar/bar?${params}`, { credentials: "same-origin", cache: "no-store" });
		if (response.status !== 200) {
			// Not signed in any more (the endpoint also cleared the marker).
			if (root.dataset.adminSite !== "photos") writeMarker(false);
			release();
			return;
		}
		const template = document.createElement("template");
		template.innerHTML = (await response.text()).trim();
		const bar = template.content.querySelector<HTMLElement>(".adminbar");
		if (!bar) return release();
		const skip = document.querySelector(".skip-link");
		if (skip) skip.after(bar);
		else document.body.prepend(bar);
		bind(bar);
	} catch {
		release();
	}
}
