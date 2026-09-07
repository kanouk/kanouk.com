import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.location = new URL("https://blog.kanouk.com/posts/source");
const { applyPublicLinkPreview } = await import("../plugins/yohaku-content-blocks/src/link-preview-client.ts");

function fakeCard({ manualTitle = false, manualDescription = false, manualImage = false } = {}) {
	const title = { textContent: manualTitle ? "Manual title" : "Old auto title" };
	const description = { textContent: manualDescription ? "Manual description" : "Old auto description", hidden: false };
	const image = { src: "https://old.example.org/card.jpg" };
	const thumb = { hidden: false, querySelector: (selector) => selector === "img" ? image : null };
	const classes = new Set();
	return {
		card: {
			dataset: {
				manualTitle: String(manualTitle),
				manualDescription: String(manualDescription),
				manualImage: String(manualImage),
				fallbackTitle: "/posts/target",
			},
			href: "https://blog.kanouk.com/posts/target",
			classList: {
				add: (value) => classes.add(value),
				remove: (value) => classes.delete(value),
			},
			querySelector(selector) {
				if (selector.includes("yohaku-link-card__thumb")) return thumb;
				if (selector.includes("link-preview-title")) return title;
				if (selector.includes("link-preview-description")) return description;
				return null;
			},
		},
		title,
		description,
		image,
		thumb,
		classes,
	};
}

test("current automatic metadata updates only fields without manual overrides", () => {
	const view = fakeCard({ manualTitle: true });
	applyPublicLinkPreview(view.card, {
		state: "refreshed",
		authoritative: false,
		metadata: {
			version: 1,
			url: "https://example.org/new",
			title: "Automatic title",
			description: "Automatic description",
			imageUrl: "https://images.example.org/new.jpg",
			fetchedAt: "2026-09-07T00:00:00.000Z",
		},
	});
	assert.equal(view.title.textContent, "Manual title");
	assert.equal(view.description.textContent, "Automatic description");
	assert.equal(view.description.hidden, false);
	assert.equal(view.image.src, "https://images.example.org/new.jpg");
	assert.equal(view.thumb.hidden, false);
});

test("authoritative internal unpublish removes automatic snapshot fields but preserves manual values", () => {
	const automatic = fakeCard();
	applyPublicLinkPreview(automatic.card, { state: "negative", authoritative: true });
	assert.equal(automatic.title.textContent, "/posts/target");
	assert.equal(automatic.description.textContent, "");
	assert.equal(automatic.description.hidden, true);
	assert.equal(automatic.thumb.hidden, true);
	assert.equal(automatic.classes.has("has-no-image"), true);

	const manual = fakeCard({ manualTitle: true, manualDescription: true, manualImage: true });
	applyPublicLinkPreview(manual.card, { state: "negative", authoritative: true });
	assert.equal(manual.title.textContent, "Manual title");
	assert.equal(manual.description.textContent, "Manual description");
	assert.equal(manual.thumb.hidden, false);
});

test("external automatic metadata cannot display an own-site media URL", () => {
	const view = fakeCard();
	applyPublicLinkPreview(view.card, {
		state: "fresh",
		authoritative: false,
		metadata: {
			version: 1,
			url: "https://example.org/article",
			title: "External",
			description: "",
			imageUrl: "https://blog.kanouk.com/_emdash/api/media/file/orphan.jpg",
			fetchedAt: "2026-09-07T00:00:00.000Z",
		},
	});
	assert.equal(view.thumb.hidden, true);
	assert.equal(view.classes.has("has-no-image"), true);
	assert.equal(view.description.textContent, "");
	assert.equal(view.description.hidden, true);
});
