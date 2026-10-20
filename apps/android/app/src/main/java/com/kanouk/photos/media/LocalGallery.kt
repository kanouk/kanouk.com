package com.kanouk.photos.media

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class LocalPhoto(
	val id: Long,
	val uri: Uri,
	val name: String,
	val size: Long,
	val takenAt: Long,
	val bucket: String,
	val width: Int,
	val height: Int,
	val mimeType: String,
) {
	/** Same identity as the web organizer (`name|size`), so either can skip what the other added. */
	val uploadKey get() = "$name|$size"
}

/** Types the site accepts (the web organizer's list). */
val ACCEPTED_TYPES = setOf("image/jpeg", "image/png", "image/webp", "image/gif")

object LocalGallery {
	suspend fun photos(context: Context): List<LocalPhoto> = withContext(Dispatchers.IO) {
		val projection = arrayOf(
			MediaStore.Images.Media._ID,
			MediaStore.Images.Media.DISPLAY_NAME,
			MediaStore.Images.Media.SIZE,
			MediaStore.Images.Media.DATE_TAKEN,
			MediaStore.Images.Media.DATE_ADDED,
			MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
			MediaStore.Images.Media.WIDTH,
			MediaStore.Images.Media.HEIGHT,
			MediaStore.Images.Media.MIME_TYPE,
		)
		val photos = mutableListOf<LocalPhoto>()
		context.contentResolver.query(
			MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, null, null,
			"${MediaStore.Images.Media.DATE_TAKEN} DESC",
		)?.use { cursor ->
			val id = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
			val name = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
			val size = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
			val taken = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
			val added = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
			val bucket = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
			val width = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
			val height = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
			val mime = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
			while (cursor.moveToNext()) {
				val type = cursor.getString(mime) ?: continue
				if (type !in ACCEPTED_TYPES) continue
				val mediaId = cursor.getLong(id)
				photos += LocalPhoto(
					id = mediaId,
					uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, mediaId),
					name = cursor.getString(name) ?: "photo.jpg",
					size = cursor.getLong(size),
					takenAt = cursor.getLong(taken).takeIf { it > 0 } ?: (cursor.getLong(added) * 1000),
					bucket = cursor.getString(bucket) ?: "その他",
					width = cursor.getInt(width),
					height = cursor.getInt(height),
					mimeType = type,
				)
			}
		}
		photos
	}
}
