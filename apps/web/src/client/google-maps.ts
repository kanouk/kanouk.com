/// <reference types="google.maps" />

// A browser key, limited to this site's hosts in Google Cloud. Set at build time.
const API_KEY = import.meta.env.PUBLIC_GOOGLE_MAPS_API_KEY as string | undefined;
const CALLBACK = "__yohakuGoogleMapsReady";

let loading: Promise<typeof google.maps> | undefined;

/** Load the Maps script once, right before the first map is drawn: each map load is billed. */
export function loadGoogleMaps(): Promise<typeof google.maps> {
	loading ??= new Promise<typeof google.maps>((resolve, reject) => {
		if (!API_KEY) throw new Error("PUBLIC_GOOGLE_MAPS_API_KEY is not set");
		const params = new URLSearchParams({ key: API_KEY, v: "weekly", language: "ja", region: "JP", callback: CALLBACK });
		const script = document.createElement("script");
		script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
		script.async = true;
		(window as unknown as Record<string, () => void>)[CALLBACK] = () => resolve(google.maps);
		script.addEventListener("error", () => {
			script.remove();
			loading = undefined;
			reject(new Error("The map script could not be loaded"));
		}, { once: true });
		document.head.append(script);
	});
	return loading;
}

/** The site's round pin. Advanced markers would need a Map ID in Google Cloud as well. */
export function pinIcon(maps: typeof google.maps, color: string, scale: number): google.maps.Symbol {
	return { path: maps.SymbolPath.CIRCLE, scale, fillColor: color, fillOpacity: 0.95, strokeColor: "#fff", strokeWeight: 2 };
}
