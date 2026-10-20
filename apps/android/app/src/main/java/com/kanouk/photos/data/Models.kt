package com.kanouk.photos.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.net.URLEncoder
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun JsonElement?.asObject(): JsonObject? = this as? JsonObject
fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
fun JsonObject.child(key: String): JsonObject? = this[key] as? JsonObject

private val MEDIA_FILE = Regex("^/_emdash/api/media/file/([^/?#]+)")
private val SOURCE_FILENAME = Regex("\\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp|mp4|mov|m4v|avi|webm)$", RegexOption.IGNORE_CASE)
private val CAMERA_NUMBER = Regex("^[\\d_-]+$")
private val SITE_ZONE: ZoneId = ZoneId.of("Asia/Tokyo")
private val DAY = DateTimeFormatter.ofPattern("yyyy/MM/dd")
private val DAY_TIME = DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm")

/** The stored-media key of an EmDash image value, used to build resized preview URLs. */
fun mediaKey(image: JsonObject?): String? {
	image ?: return null
	image.child("meta")?.string("storageKey")?.let { return it }
	val src = image.string("src") ?: image.string("url") ?: return null
	return MEDIA_FILE.find(src)?.groupValues?.get(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") }
}

/** The image's own address, for values that are not stored media (old imports, fixtures). */
fun mediaSource(image: JsonObject?): String? = image?.string("src") ?: image?.string("url")

fun previewPath(key: String, width: Int): String =
	"/_yohaku/media/preview-v2/$width/webp/${URLEncoder.encode(key, "UTF-8").replace("+", "%20")}"

/** A capture time as the site shows it: "2026/03/11 12:44" in Japan time. Values without a zone are wall-clock time. */
fun siteDateTime(value: String?, withTime: Boolean = true): String? {
	value ?: return null
	val format = if (withTime) DAY_TIME else DAY
	return runCatching { OffsetDateTime.parse(value).atZoneSameInstant(SITE_ZONE).format(format) }
		.recoverCatching { Instant.parse(value).atZone(SITE_ZONE).format(format) }
		.recoverCatching { LocalDateTime.parse(value.take(19)).format(format) }
		.getOrNull()
}

fun looksLikeFileName(text: String?): Boolean = text != null && (SOURCE_FILENAME.containsMatchIn(text.trim()) || CAMERA_NUMBER.matches(text.trim()))

data class Album(
	val id: String,
	val slug: String?,
	val status: String,
	val title: String,
	val description: String,
	val cover: JsonObject?,
	val capturedFrom: String?,
	val capturedTo: String?,
	val draftRevisionId: String?,
	private val liveRevisionId: String?,
) {
	val isPublished get() = status == "published"
	val hasPendingChanges get() = status != "published" || (draftRevisionId != null && draftRevisionId != liveRevisionId)
	val coverKey get() = mediaKey(cover)
	val coverSource get() = mediaSource(cover)

	val period: String?
		get() {
			val from = siteDateTime(capturedFrom, withTime = false) ?: return null
			val to = siteDateTime(capturedTo, withTime = false)
			return when {
				to == null || to == from -> from
				to.take(4) == from.take(4) -> "$from〜${to.drop(5)}"
				else -> "$from〜$to"
			}
		}

	companion object {
		fun from(item: JsonObject): Album {
			val data = item.child("data") ?: JsonObject(emptyMap())
			return Album(
				id = item.string("id").orEmpty(),
				slug = item.string("slug"),
				status = item.string("status") ?: "draft",
				title = data.string("title") ?: "無題のアルバム",
				description = data.string("description").orEmpty(),
				cover = data.child("cover_image"),
				capturedFrom = data.string("captured_from"),
				capturedTo = data.string("captured_to"),
				draftRevisionId = item.string("draftRevisionId"),
				liveRevisionId = item.string("liveRevisionId"),
			)
		}
	}
}

data class Photo(
	val id: String,
	val slug: String?,
	val status: String,
	val title: String,
	val caption: String,
	val alt: String,
	val albumId: String?,
	val position: Double,
	val capturedAt: String?,
	val latitude: Double?,
	val longitude: Double?,
	val image: JsonObject?,
	val sourceMetadata: JsonObject,
	val draftRevisionId: String?,
	private val liveRevisionId: String?,
) {
	val hidden get() = sourceMetadata.flag("hidden") == true
	val isPublished get() = status == "published"
	val hasPendingChanges get() = !hidden && (status != "published" || (draftRevisionId != null && draftRevisionId != liveRevisionId))
	val imageKey get() = mediaKey(image)
	val imageSource get() = mediaSource(image)
	val uploadKey get() = sourceMetadata.string("upload_key")
	val contentHash get() = sourceMetadata.string("content_hash")
	val hasLocation get() = latitude != null && longitude != null

	/** The title EmDash was given from the file name at upload ("PXL_2026….jpg" → "PXL 2026…"). */
	private val autoTitle: String?
		get() = image?.string("filename")?.substringBeforeLast('.')?.replace(Regex("[_-]+"), " ")?.trim()

	/** Caption or title, unless it is only a file name, camera number or the title made from the file name. */
	val displayTitle: String?
		get() = listOf(caption, title).firstOrNull { it.isNotBlank() && !looksLikeFileName(it) && it.trim() != autoTitle }

	val stateLabel: String?
		get() = when {
			hidden -> "非公開"
			status != "published" -> "下書き"
			hasPendingChanges -> "変更あり"
			else -> null
		}

	companion object {
		fun from(item: JsonObject): Photo {
			val data = item.child("data") ?: JsonObject(emptyMap())
			return Photo(
				id = item.string("id").orEmpty(),
				slug = item.string("slug"),
				status = item.string("status") ?: "draft",
				title = data.string("title").orEmpty(),
				caption = data.string("caption").orEmpty(),
				alt = data.string("alt").orEmpty(),
				albumId = data.string("album"),
				position = data.number("position") ?: 0.0,
				capturedAt = data.string("captured_at"),
				latitude = data.number("latitude"),
				longitude = data.number("longitude"),
				image = data.child("image"),
				sourceMetadata = data.child("source_metadata") ?: JsonObject(emptyMap()),
				draftRevisionId = item.string("draftRevisionId"),
				liveRevisionId = item.string("liveRevisionId"),
			)
		}
	}
}

data class AlbumCount(val total: Int, val pending: Int, val maxPosition: Double)
