import { loadGoogleMaps, pinIcon } from "./google-maps";
import { loadMapStyle } from "./map-style";

export type MapMarker = { latitude: number; longitude: number; title: string; href: string };
export type DrawnMap = { resize(): void; remove(): void };

const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CONTROLS = { scrollwheel: false, mapTypeControl: false, streetViewControl: false, fullscreenControl: false };
const GOOGLE_DRAWN: DrawnMap = { resize() {}, remove() {} };

/** Ask the site before each Google map: past the monthly limit, or on any failure, use OpenStreetMap. */
async function useGoogle(): Promise<typeof google.maps | null> {
	try {
		const response = await fetch("/map-provider", { method: "POST" });
		if (!response.ok) return null;
		const { provider } = await response.json() as { provider: string };
		return provider === "google" ? await loadGoogleMaps() : null;
	} catch {
		return null;
	}
}

async function loadLeaflet() {
	const [{ default: L }] = await Promise.all([import("leaflet"), loadMapStyle()]);
	return L;
}

function drawnLeaflet(map: import("leaflet").Map): DrawnMap {
	return { resize: () => map.invalidateSize(), remove: () => map.remove() };
}

/** One place, for a photo. */
export async function showPlace(canvas: HTMLElement, latitude: number, longitude: number, color: string): Promise<DrawnMap | undefined> {
	const maps = await useGoogle();
	if (!canvas.isConnected) return undefined;
	if (maps) {
		const center = { lat: latitude, lng: longitude };
		const map = new maps.Map(canvas, { center, zoom: 15, ...CONTROLS });
		new maps.Marker({ map, position: center, icon: pinIcon(maps, color, 7) });
		return GOOGLE_DRAWN;
	}
	const L = await loadLeaflet();
	if (!canvas.isConnected) return undefined;
	const map = L.map(canvas, { scrollWheelZoom: false, attributionControl: false, zoomControl: true }).setView([latitude, longitude], 15);
	L.control.attribution({ prefix: false }).addAttribution(OSM_ATTRIBUTION).addTo(map);
	L.tileLayer(OSM_TILES, { maxZoom: 19 }).addTo(map);
	L.circleMarker([latitude, longitude], { radius: 7, weight: 2, color: "#fff", fillColor: color, fillOpacity: 0.95 }).addTo(map);
	return drawnLeaflet(map);
}

function markerLink(marker: MapMarker): HTMLAnchorElement {
	const link = document.createElement("a");
	link.href = marker.href;
	link.textContent = marker.title;
	return link;
}

/** Many places, for an album. */
export async function showMarkers(canvas: HTMLElement, markers: MapMarker[], color: string): Promise<DrawnMap> {
	const maps = await useGoogle();
	canvas.textContent = "";
	if (maps) {
		const map = new maps.Map(canvas, CONTROLS);
		const popup = new maps.InfoWindow();
		const bounds = new maps.LatLngBounds();
		markers.forEach((marker) => {
			const position = { lat: marker.latitude, lng: marker.longitude };
			bounds.extend(position);
			const link = markerLink(marker);
			const pin = new maps.Marker({ map, position, title: marker.title, icon: pinIcon(maps, color, 5) });
			pin.addListener("click", () => {
				popup.setContent(link);
				popup.open({ map, anchor: pin });
			});
		});
		// fitBounds has no zoom limit, and a single place would fill the map.
		maps.event.addListenerOnce(map, "idle", () => {
			if ((map.getZoom() ?? 0) > 15) map.setZoom(15);
		});
		map.fitBounds(bounds, 28);
		return GOOGLE_DRAWN;
	}
	const L = await loadLeaflet();
	const map = L.map(canvas, { scrollWheelZoom: false, zoomControl: true });
	L.tileLayer(OSM_TILES, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);
	const bounds = L.latLngBounds([]);
	markers.forEach((marker) => {
		const point = L.latLng(marker.latitude, marker.longitude);
		bounds.extend(point);
		L.circleMarker(point, { radius: 5, weight: 1.5, color: "#fff", fillColor: color, fillOpacity: 0.88 }).bindPopup(markerLink(marker)).addTo(map);
	});
	map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
	return drawnLeaflet(map);
}
