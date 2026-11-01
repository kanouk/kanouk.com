package com.kanouk.photos.data

import com.kanouk.photos.media.removeLocation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/**
 * Album and photo operations, following the web organizer (src/studio/admin.tsx)
 * so the app and the admin leave the same data behind.
 */
private val LOCATION_KEYS = setOf("gps", "gpslatitude", "gpslongitude", "gpsaltitude", "latitude", "longitude", "altitude", "location", "geotag")

class PhotoActions(private val api: EmDashApi) {
	/** Saves that read a revision and then write it; location removal runs beside them in the background. */
	private val writes = Mutex()

	/** Publish the album and every photo with unpublished changes, except hidden ones. */
	suspend fun publishAlbum(album: Album): Int {
		val photos = api.allAlbumPhotos(album.id)
		var published = 0
		val failed = mutableListOf<String>()
		for (photo in photos.filter { it.hasPendingChanges }) {
			runCatching { api.publish("photos", photo.id); published += 1 }.onFailure { failed += photo.id }
		}
		if (failed.isNotEmpty()) throw ApiException("${failed.size}点を公開できませんでした。もう一度お試しください。")
		api.publish("albums", album.id)
		api.recordOperation("album-publish", "complete", listOf(album.id), album.id)
		return published
	}

	/** Hidden photos stay off the public site, even when the album is published. */
	suspend fun setHidden(photo: Photo, hidden: Boolean) = writes.withLock {
		val (item, rev) = api.content("photos", photo.id)
		val metadata = item.child("data")?.child("source_metadata") ?: JsonObject(emptyMap())
		val next = JsonObject(metadata.filterKeys { it != "hidden" } + if (hidden) mapOf("hidden" to JsonPrimitive(true)) else emptyMap())
		api.updateDraft("photos", photo.id, rev, buildJsonObject { put("source_metadata", next) })
		if (hidden && item.string("status") == "published") api.unpublish("photos", photo.id)
		if (!hidden) api.publish("photos", photo.id)
		api.recordOperation(if (hidden) "photo-hide" else "photo-show", "complete", listOf(photo.id), photo.albumId.orEmpty())
	}

	/** Edits to a public photo in a public album go live on saving. Returns whether they did. */
	suspend fun editPhoto(album: Album, photo: Photo, title: String, caption: String): Boolean = writes.withLock {
		val (_, rev) = api.content("photos", photo.id)
		api.updateDraft("photos", photo.id, rev, buildJsonObject {
			put("title", title.ifBlank { photo.title })
			put("caption", caption)
			// The web organizer requires alt text; keep it in step with a real title.
			if (photo.alt.isBlank() || looksLikeFileName(photo.alt)) put("alt", title.ifBlank { photo.title })
		})
		val live = album.goesLiveWith(photo)
		if (live) api.publish("photos", photo.id)
		live
	}

	/**
	 * Remove a photo's location from its fields and from the stored file, which the public
	 * can fetch while a live revision refers to it. A public photo or cover goes live at
	 * once, because the old file stays reachable until it does. The replaced file is kept
	 * for the owner only (as in scripts/migration/redact_photo_locations.py).
	 */
	suspend fun clearLocation(album: Album, photo: Photo, workDir: File) {
		val (item, _) = api.content("photos", photo.id)
		val image = item.child("data")?.child("image") ?: throw ApiException("この写真には画像がありません。")
		val storageKey = mediaKey(image) ?: throw ApiException("この写真の元ファイルを読み込めません。")
		val filename = image.string("filename") ?: "photo.jpg"
		val mimeType = image.string("mimeType") ?: "image/jpeg"
		val file = File.createTempFile("location-", ".tmp", workDir)
		try {
			api.downloadMedia(storageKey, file)
			val changed = withContext(Dispatchers.IO) { removeLocation(file, mimeType) }
			val newImage = if (changed) api.imageValue(api.uploadMedia(file.asRequestBody(mimeType.toMediaType()), filename, image.number("width")?.toInt() ?: 0, image.number("height")?.toInt() ?: 0)) else null
			// The transfer takes a while and the owner can keep editing, so read the revisions afterwards.
			writes.withLock {
				// The cover first: if the photo then fails, trying again still has work to do.
				if (newImage != null) replaceCover(album.id, storageKey, newImage)
				val (fresh, rev) = api.content("photos", photo.id)
				val data = fresh.child("data") ?: JsonObject(emptyMap())
				api.updateDraft("photos", photo.id, rev, buildJsonObject {
					newImage?.let { put("image", it) }
					put("latitude", JsonNull)
					put("longitude", JsonNull)
					put("altitude", JsonNull)
					put("source_metadata", JsonObject(((withoutLocation(data.child("source_metadata")) as? JsonObject) ?: JsonObject(emptyMap())) + ("location_review" to JsonPrimitive("clean"))))
				})
				if (fresh.string("status") == "published") api.publish("photos", photo.id)
			}
			api.recordOperation("photo-location-remove", "complete", listOf(photo.id), album.id)
		} finally {
			file.delete()
		}
	}

	private suspend fun replaceCover(albumId: String, storageKey: String, image: JsonObject) {
		val (item, rev) = api.content("albums", albumId)
		val draftCover = mediaKey(item.child("data")?.child("cover_image")) == storageKey
		val published = item.string("status") == "published"
		// With unpublished album changes, the live cover (in the list) can differ from the draft's.
		val liveCover = published && !draftCover && item.string("draftRevisionId") != null && item.string("draftRevisionId") != item.string("liveRevisionId") &&
			api.albums().firstOrNull { it.id == albumId }?.coverKey == storageKey
		// The new file shows the same picture, so the chosen crop stays.
		val cover = item.child("data")?.child("cover_image")
		if (draftCover) api.updateDraft("albums", albumId, rev, buildJsonObject { put("cover_image", image.withCoverCrop(cover?.child("meta")?.get("crop"))) })
		if (published && (draftCover || liveCover)) api.publish("albums", albumId)
	}

	private fun withoutLocation(value: JsonElement?): JsonElement? = when (value) {
		is JsonObject -> JsonObject(value.filterKeys { it.lowercase().replace(Regex("[^a-z]"), "") !in LOCATION_KEYS }.mapValues { (_, child) -> withoutLocation(child) ?: JsonNull })
		is JsonArray -> JsonArray(value.map { withoutLocation(it) ?: JsonNull })
		else -> value
	}

	/** A public album takes a public photo as its cover at once. Returns whether it did. */
	suspend fun makeCover(album: Album, photo: Photo, crop: CoverCrop? = null): Boolean = writes.withLock {
		val image = photo.image?.withCoverCrop(crop.toJson()) ?: throw ApiException("この写真には画像がありません。")
		val (_, rev) = api.content("albums", album.id)
		api.updateDraft("albums", album.id, rev, buildJsonObject { put("cover_image", image) })
		val live = album.goesLiveWith(photo)
		if (live) api.publish("albums", album.id)
		live
	}

	suspend fun renameAlbum(album: Album, title: String, description: String) {
		val (_, rev) = api.content("albums", album.id)
		api.updateDraft("albums", album.id, rev, buildJsonObject { put("title", title); put("description", description) })
	}

	/**
	 * A sort change on a published album without other pending edits goes live at once,
	 * as in SmugMug; otherwise it waits for 公開 with the rest. Returns whether it was published.
	 */
	suspend fun setAlbumSort(album: Album, method: String, direction: String): Boolean {
		val live = album.isPublished && !album.hasPendingChanges
		val (_, rev) = api.content("albums", album.id)
		api.updateDraft("albums", album.id, rev, buildJsonObject { put("sort_method", method); put("sort_direction", direction) })
		if (live) api.publish("albums", album.id)
		return live
	}

	/** A manual move: published photos with nothing else pending stay live; hidden ones never publish. */
	suspend fun setPosition(photo: Photo, position: Double) {
		val (_, rev) = api.content("photos", photo.id)
		api.updateDraft("photos", photo.id, rev, buildJsonObject {
			if (position % 1.0 == 0.0) put("position", position.toLong()) else put("position", position)
		})
		if (photo.isPublished && !photo.hidden && !photo.hasPendingChanges) api.publish("photos", photo.id)
	}

	/**
	 * Delete an album after its photos go to the trash too, or move to [moveTo] (published
	 * photos stay live there). The album is kept if any photo fails. Returns the photo count.
	 */
	suspend fun deleteAlbum(album: Album, moveTo: Album?): Int {
		val photos = api.allAlbumPhotos(album.id)
		var position = moveTo?.let { target -> api.allAlbumPhotos(target.id).maxOfOrNull { it.position } } ?: 0.0
		var failed = 0
		for (photo in photos) runCatching {
			if (moveTo == null) api.trash("photos", photo.id)
			else {
				position += 1024
				val (_, rev) = api.content("photos", photo.id)
				api.updateDraft("photos", photo.id, rev, buildJsonObject { put("album", moveTo.id); put("position", position.toLong()) })
				if (photo.isPublished && !photo.hidden && !photo.hasPendingChanges) api.publish("photos", photo.id)
			}
		}.onFailure { failed++ }
		if (failed > 0) throw ApiException("${failed}点の写真を処理できなかったため、アルバムは削除していません。")
		api.trash("albums", album.id)
		api.recordOperation("album-trash", "complete", listOf(album.id) + photos.map { it.id }, album.id)
		return photos.size
	}

	suspend fun trash(album: Album, photo: Photo) {
		if (album.coverKey != null && album.coverKey == photo.imageKey) throw ApiException("表紙の写真は、別の写真を表紙にしてから削除してください。")
		api.trash("photos", photo.id)
		api.recordOperation("photo-trash", "complete", listOf(photo.id), album.id)
	}
}
