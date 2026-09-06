import assert from "node:assert/strict";
import test from "node:test";

const workflow = await import("../src/studio/organizer-workflow.ts");

const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

test("upload queue validates each file and assigns stable sparse positions", () => {
	const queue = workflow.createUploadQueue([
		{ name: "one.jpg", type: "image/jpeg", size: 10, lastModified: 1 },
		{ name: "two.avif", type: "image/avif", size: 100, lastModified: 2 },
		{ name: "large.png", type: "image/png", size: 60 * 1024 * 1024, lastModified: 3 },
	], {
		batchId: "batch",
		startPosition: 2048,
		acceptedTypes,
		maxBytes: 50 * 1024 * 1024,
		maxFiles: 20,
	});

	assert.deepEqual(queue.map(({ stage, position }) => ({ stage, position })), [
		{ stage: "queued", position: 3072 },
		{ stage: "failed-validation", position: 4096 },
		{ stage: "failed-validation", position: 5120 },
	]);
	assert.match(queue[1].error, /JPEG、PNG、WebP、GIF/);
});

test("failed Photo creation retries from media-ready without discarding the File or requeueing Media", () => {
	const file = { name: "photo.jpg", type: "image/jpeg", size: 100, lastModified: 10 };
	const media = { id: "media-1", storageKey: "photo.jpg" };
	let queue = workflow.createUploadQueue([file], {
		batchId: "batch",
		startPosition: 0,
		acceptedTypes,
		maxBytes: 1000,
		maxFiles: 20,
	});
	queue = workflow.updateUploadQueueItem(queue, queue[0].id, {
		stage: "failed-photo",
		media,
		error: "Photo creation failed",
	});
	const retried = workflow.retryFailedUploadQueue(queue);

	assert.equal(retried[0].stage, "media-ready");
	assert.equal(retried[0].file, file);
	assert.equal(retried[0].media, media);
});

test("media upload failures retry from queued while validation failures remain settled", () => {
	const queue = [
		{ id: "media", file: { name: "a.jpg", type: "image/jpeg", size: 1 }, position: 1024, stage: "failed-media", error: "network" },
		{ id: "invalid", file: { name: "a.avif", type: "image/avif", size: 1 }, position: 2048, stage: "failed-validation", error: "type" },
	];
	const retried = workflow.retryFailedUploadQueue(queue);
	assert.equal(retried[0].stage, "queued");
	assert.equal(retried[1].stage, "failed-validation");
	assert.equal(workflow.isUploadQueueRetryable(retried[1].stage), false);
});

test("caption navigation advances only after a successful save", () => {
	const ids = ["first", "second", "third"];
	const next = workflow.adjacentPhotoId(ids, "second", 1);
	const previous = workflow.adjacentPhotoId(ids, "second", -1);
	assert.equal(workflow.captionSelectionAfterSave("second", next, false), "second");
	assert.equal(workflow.captionSelectionAfterSave("second", next, true), "third");
	assert.equal(workflow.captionSelectionAfterSave("second", previous, true), "first");
	assert.equal(workflow.adjacentPhotoId(ids, "third", 1), null);
});

test("single-item draft hydration replaces live list data and retains its editing revision", () => {
	const listed = {
		id: "photo-1",
		updatedAt: "2026-09-06T01:00:00.000Z",
		liveRevisionId: "live-1",
		draftRevisionId: "draft-1",
		data: { caption: "published caption" },
	};
	const hydratedEnvelope = workflow.attachEditingRevision({
		_rev: "draft-1:baseline",
		item: { ...listed, data: { caption: "saved draft caption" } },
	});
	const hydrated = hydratedEnvelope.item;

	let items = workflow.mergeEditableItems([listed], [hydrated]);
	assert.equal(items[0].data.caption, "saved draft caption");
	assert.equal(items[0]._rev, "draft-1:baseline");

	items = workflow.mergeEditableItems(items, [listed]);
	assert.equal(items[0].data.caption, "saved draft caption", "a later live list page must not undo hydration");
	assert.equal(items[0]._rev, "draft-1:baseline");
});

test("a changed draft identity invalidates a previously hydrated editing baseline", () => {
	const hydrated = {
		id: "album-1",
		updatedAt: "2026-09-06T01:00:00.000Z",
		draftRevisionId: "draft-1",
		_rev: "draft-1:baseline",
		data: { title: "hydrated draft" },
	};
	const changedListItem = {
		...hydrated,
		draftRevisionId: "draft-2",
		_rev: undefined,
		data: { title: "published title" },
	};
	const [result] = workflow.mergeEditableItems([hydrated], [changedListItem]);
	assert.equal(result._rev, undefined);
	assert.equal(result.draftRevisionId, "draft-2");
});

test("caption-only saves omit an absent or untouched captured_at value", () => {
	const empty = workflow.preparePhotoDraftPatch(undefined, {
		title: "Title",
		caption: "Changed caption",
		alt: "Alt",
		captured_at: "",
		album: "album-1",
	});
	assert.deepEqual(empty.patch, {
		title: "Title",
		caption: "Changed caption",
		alt: "Alt",
		album: "album-1",
	});

	const stored = "2026-09-06T12:34:56.789+09:00";
	const untouched = workflow.preparePhotoDraftPatch(stored, {
		title: "Title",
		caption: "Changed caption",
		alt: "Alt",
		captured_at: workflow.dateTimeLocalInputValue(stored),
		album: "album-1",
	});
	assert.equal("captured_at" in untouched.patch, false);
});

test("an intentional datetime clear uses null and an edited local value uses ISO", () => {
	const stored = "2026-09-06T12:34:56.789+09:00";
	const cleared = workflow.preparePhotoDraftPatch(stored, {
		title: "Title",
		caption: "Caption",
		alt: "Alt",
		captured_at: "",
		album: "album-1",
	});
	assert.equal(cleared.patch.captured_at, null);

	const editedInput = "2026-09-07T08:15";
	const edited = workflow.preparePhotoDraftPatch(stored, {
		title: "Title",
		caption: "Caption",
		alt: "Alt",
		captured_at: editedInput,
		album: "album-1",
	});
	assert.equal(edited.dateError, undefined);
	assert.equal(edited.patch.captured_at, new Date(editedInput).toISOString());

	const invalid = workflow.preparePhotoDraftPatch(stored, {
		title: "Title",
		caption: "Caption",
		alt: "Alt",
		captured_at: "not-a-date",
		album: "album-1",
	});
	assert.match(invalid.dateError, /撮影日/);
	assert.equal("captured_at" in invalid.patch, false);
});

test("published derivative helpers expose only the five preview-v2 sizes", () => {
	const image = { meta: { storageKey: "folder/photo.jpg" } };
	assert.deepEqual(
		workflow.PUBLIC_IMAGE_WIDTHS.map((width) => workflow.publicImageVariantPath(image, width)),
		[320, 480, 768, 1200, 1600].map((width) => `/_yohaku/media/preview-v2/${width}/webp/folder%2Fphoto.jpg`),
	);
	assert.equal(workflow.publicImageVariantPath({ id: "draft-media-only" }, 320), null);
	assert.equal(workflow.publicImageVariantPath(image, 999), null);
	assert.equal(workflow.canCopyPublishedImageVariants({
		status: "published",
		draftRevisionId: "draft-2",
		liveRevisionId: "live-1",
	}), false);
	assert.equal(workflow.canCopyPublishedImageVariants({
		status: "published",
		draftRevisionId: "live-1",
		liveRevisionId: "live-1",
	}), true);
	assert.equal(workflow.canCopyPublishedImageVariants({ status: "draft" }), false);
});
