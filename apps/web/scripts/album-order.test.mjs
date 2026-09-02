import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sortAlbumsLikeSmugMug } from "../src/utils/album-order.mjs";

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
