import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applySavedAlbumOrder, sortAlbumsLikeSmugMug } from "../src/utils/album-order.mjs";

const album = (id, title) => ({ id, data: { title } });

describe("sortAlbumsLikeSmugMug", () => {
	test("pins curated albums and sorts dated albums newest first", () => {
		const unordered = [
			album("stations", "Stations"),
			album("2024-07-kyoto", "Kyoto, 2024/07"),
			album("stream", "Stream"),
			album("2026-03-fukuoka", "Fukuoka, 2026/03"),
		];
		assert.deepEqual(
			sortAlbumsLikeSmugMug(unordered).map(({ id }) => id),
			["stream", "2026-03-fukuoka", "2024-07-kyoto", "stations"],
		);
	});

	test("keeps SmugMug's curated order for albums in the same month", () => {
		const unordered = [
			album("2020-11-kyoto", "Kyoto, 2020/11"),
			album("2023-01-nara-kyoto", "Nara/Kyoto, 2023/01"),
			album("2020-11-miyajima-kure", "Miyajima/Kure, 2020/11"),
			album("2023-01-kyoto", "Kyoto, 2023/01"),
		];
		assert.deepEqual(
			sortAlbumsLikeSmugMug(unordered).map(({ id }) => id),
			[
				"2023-01-kyoto",
				"2023-01-nara-kyoto",
				"2020-11-miyajima-kure",
				"2020-11-kyoto",
			],
		);
	});
});

describe("applySavedAlbumOrder", () => {
	const withId = (slug, id, title) => ({ id: slug, data: { id, title } });
	const albums = [
		withId("stream", "A1", "Stream"),
		withId("2026-03-fukuoka", "A2", "Fukuoka, 2026/03"),
		withId("2024-07-kyoto", "A3", "Kyoto, 2024/07"),
		withId("2026-10-new", "A4", "Sendai, 2026/10"),
	];
	test("without a saved order, keeps the SmugMug-like default", () => {
		assert.deepEqual(applySavedAlbumOrder(albums, []).map(({ id }) => id), ["stream", "2026-10-new", "2026-03-fukuoka", "2024-07-kyoto"]);
	});
	test("follows the saved order and puts albums added since then first", () => {
		assert.deepEqual(applySavedAlbumOrder(albums, ["A3", "A1", "A2", "gone"]).map(({ id }) => id), ["2026-10-new", "2024-07-kyoto", "stream", "2026-03-fukuoka"]);
	});
});
