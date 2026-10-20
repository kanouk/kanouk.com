package com.kanouk.photos.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Album and photo operations, following the web organizer (src/studio/admin.tsx)
 * so the app and the admin leave the same data behind.
 */
class PhotoActions(private val api: EmDashApi) {

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
	suspend fun setHidden(photo: Photo, hidden: Boolean) {
		val (item, rev) = api.content("photos", photo.id)
		val metadata = item.child("data")?.child("source_metadata") ?: JsonObject(emptyMap())
		val next = JsonObject(metadata.filterKeys { it != "hidden" } + if (hidden) mapOf("hidden" to kotlinx.serialization.json.JsonPrimitive(true)) else emptyMap())
		api.updateDraft("photos", photo.id, rev, buildJsonObject { put("source_metadata", next) })
		if (hidden && item.string("status") == "published") api.unpublish("photos", photo.id)
		if (!hidden) api.publish("photos", photo.id)
		api.recordOperation(if (hidden) "photo-hide" else "photo-show", "complete", listOf(photo.id), photo.albumId.orEmpty())
	}

	suspend fun editPhoto(photo: Photo, title: String, caption: String) {
		val (_, rev) = api.content("photos", photo.id)
		api.updateDraft("photos", photo.id, rev, buildJsonObject {
			put("title", title.ifBlank { photo.title })
			put("caption", caption)
			// The web organizer requires alt text; keep it in step with a real title.
			if (photo.alt.isBlank() || looksLikeFileName(photo.alt)) put("alt", title.ifBlank { photo.title })
		})
	}

	suspend fun makeCover(album: Album, photo: Photo) {
		val image = photo.image ?: throw ApiException("この写真には画像がありません。")
		val (_, rev) = api.content("albums", album.id)
		api.updateDraft("albums", album.id, rev, buildJsonObject { put("cover_image", image) })
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

	suspend fun trash(album: Album, photo: Photo) {
		if (album.coverKey != null && album.coverKey == photo.imageKey) throw ApiException("表紙の写真は、別の写真を表紙にしてから削除してください。")
		api.trash("photos", photo.id)
		api.recordOperation("photo-trash", "complete", listOf(photo.id), album.id)
	}
}
