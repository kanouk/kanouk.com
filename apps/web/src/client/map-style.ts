// Leaflet's stylesheet is referenced as a built asset URL, not imported as CSS:
// Astro hoists CSS imported by a page script into a render-blocking <link> on
// every page that includes the script (it reached the blog, which has no map).
import href from "leaflet/dist/leaflet.css?url";

let loading: Promise<void> | undefined;

/** Load Leaflet's stylesheet once, right before the first map is drawn. */
export function loadMapStyle(): Promise<void> {
	loading ??= new Promise<void>((resolve, reject) => {
		if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) {
			resolve();
			return;
		}
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		link.addEventListener("load", () => resolve(), { once: true });
		link.addEventListener("error", () => {
			link.remove();
			loading = undefined;
			reject(new Error("The map stylesheet could not be loaded"));
		}, { once: true });
		document.head.append(link);
	});
	return loading;
}
