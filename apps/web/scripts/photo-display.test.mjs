import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { looksLikeSourceFilename, publicPhotoTitle } from "../src/utils/photo-display.mjs";

describe("publicPhotoTitle", () => {
	test("hides the legacy SmugMug filename fallback", () => {
		assert.equal(publicPhotoTitle({
			title: "PXL_20240727_035027049.jpg",
			sourceSystem: "smugmug",
			sourceMetadata: { migration: "manifest-v1" },
		}), undefined);
	});

	test("uses a genuine SmugMug title", () => {
		assert.equal(publicPhotoTitle({
			title: "ホテル日航プリンセス京都 部屋",
			sourceSystem: "smugmug",
			sourceMetadata: {
				source_title: "ホテル日航プリンセス京都 部屋",
				source_filename: "PXL_20250214_151737.jpg",
			},
		}), "ホテル日航プリンセス京都 部屋");
	});

	test("allows a later editorial title to override an untitled source", () => {
		assert.equal(publicPhotoTitle({
			title: "編集後のタイトル",
			sourceSystem: "smugmug",
			sourceMetadata: {
				source_title: null,
				source_filename: "source.jpg",
			},
		}), "編集後のタイトル");
	});

	test("does not reinterpret non-SmugMug titles", () => {
		assert.equal(publicPhotoTitle({
			title: "release.jpg",
			sourceSystem: "manual",
		}), "release.jpg");
	});
});

test("looksLikeSourceFilename recognises supported photo and video extensions", () => {
	assert.equal(looksLikeSourceFilename("IMG_0001.HEIC"), true);
	assert.equal(looksLikeSourceFilename("clip.MOV"), true);
	assert.equal(looksLikeSourceFilename("京都駅"), false);
});
