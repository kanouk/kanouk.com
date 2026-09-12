/** Accept individual public post URLs only; never execute saved embed HTML. */
export function parseXPostUrl(input) {
	try {
		const url = new URL(typeof input === "string" ? input.trim() : "");
		if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
		if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname)) return null;
		const match = url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/);
		return match ? { id: match[1], url: `https://twitter.com/i/web/status/${match[1]}` } : null;
	} catch { return null; }
}
