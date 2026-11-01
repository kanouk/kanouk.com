package com.kanouk.photos.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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

/** The sizes offered for embedding, up to what the photo can fill (same as src/utils/photo-embed.mjs on the site). */
fun embedSizes(photoWidth: Int?): List<Pair<String, Int>> {
	val all = listOf("小" to 480, "中" to 768, "大" to 1200, "特大" to 1600)
	return all.filter { photoWidth == null || it.second <= photoWidth }.ifEmpty { all.take(1) }
}

/** HTML for another site: a resized image, which carries no location, linking to the photo page. */
fun embedCode(site: String, photo: Photo, size: Int): String? {
	val key = photo.imageKey ?: return null
	val slug = photo.slug ?: return null
	val photoWidth = photo.image?.number("width")?.toInt()?.takeIf { it > 0 }
	val photoHeight = photo.image?.number("height")?.toInt()?.takeIf { it > 0 }
	val width = minOf(size, photoWidth ?: size)
	val height = if (photoWidth != null && photoHeight != null) " height=\"${Math.round(photoHeight.toDouble() * width / photoWidth)}\"" else ""
	val alt = (photo.alt.takeUnless { it.isBlank() || looksLikeFileName(it) } ?: photo.displayTitle ?: "写真")
		.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")
	return "<a href=\"$site/p/${URLEncoder.encode(slug, "UTF-8").replace("+", "%20")}\"><img src=\"$site${previewPath(key, size)}\" width=\"$width\"$height alt=\"$alt\" loading=\"lazy\" style=\"max-width:100%;height:auto\"></a>"
}

/** A capture time as the site shows it: "2026/03/11 12:44" in Japan time. Values without a zone are wall-clock time. */
fun siteDateTime(value: String?, withTime: Boolean = true): String? {
	value ?: return null
	val format = if (withTime) DAY_TIME else DAY
	return runCatching { OffsetDateTime.parse(value).atZoneSameInstant(SITE_ZONE).format(format) }
		.recoverCatching { Instant.parse(value).atZone(SITE_ZONE).format(format) }
		.recoverCatching { LocalDateTime.parse(value.take(19)).format(format) }
		.getOrNull()
}

/** The capture day as the site counts it (Japan time), for grouping photos by date. */
fun siteDay(value: String?): java.time.LocalDate? = siteDateTime(value, withTime = false)?.let { runCatching { java.time.LocalDate.parse(it, DAY) }.getOrNull() }

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
	/** How the site orders the album's photos: "date taken", "position" (手動), "filename", …; lower case. */
	val sortMethod: String,
	val sortDirection: String,
	val draftRevisionId: String?,
	private val liveRevisionId: String?,
) {
	val isPublished get() = status == "published"
	val manualSort get() = sortMethod == "position"
	val hasPendingChanges get() = status != "published" || (draftRevisionId != null && draftRevisionId != liveRevisionId)
	val coverKey get() = mediaKey(cover)
	val coverCrop get() = CoverCrop.from(cover)
	/** Changes to this photo, or making it the cover, need no separate 公開. */
	fun goesLiveWith(photo: Photo) = isPublished && photo.isPublished && !photo.hidden
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
				sortMethod = data.string("sort_method")?.lowercase() ?: "date taken",
				sortDirection = data.string("sort_direction")?.lowercase() ?: "asc",
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
	val kind: String?,
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
	val isVideo get() = kind == "video"

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
				kind = data.string("kind"),
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

/**
 * How a cover fills its frame, kept in the cover image's meta (so choosing another cover resets it).
 * [x] and [y] (0–1) work like CSS object-position, and [zoom] scales around that same point,
 * so the app and the site show the same part of the photo in frames of any shape.
 */
data class CoverCrop(val x: Float = 0.5f, val y: Float = 0.5f, val zoom: Float = 1f) {
	val isDefault get() = x == 0.5f && y == 0.5f && zoom == 1f

	companion object {
		const val MAX_ZOOM = 3f

		fun from(image: JsonObject?): CoverCrop? {
			val crop = image?.child("meta")?.child("crop") ?: return null
			val x = crop.number("x") ?: return null
			val y = crop.number("y") ?: return null
			val zoom = crop.number("zoom") ?: return null
			return CoverCrop(x.toFloat().coerceIn(0f, 1f), y.toFloat().coerceIn(0f, 1f), zoom.toFloat().coerceIn(1f, MAX_ZOOM))
		}
	}
}

/** The image value with this crop in its meta, or none. */
fun JsonObject.withCoverCrop(crop: JsonElement?): JsonObject {
	val meta = (child("meta") ?: JsonObject(emptyMap())).filterKeys { it != "crop" } + (crop?.let { mapOf("crop" to it) } ?: emptyMap())
	return JsonObject(this + ("meta" to JsonObject(meta)))
}

fun CoverCrop?.toJson(): JsonElement? = this?.takeUnless { it.isDefault }?.let {
	buildJsonObject { put("x", it.x); put("y", it.y); put("zoom", it.zoom) }
}

data class AlbumCount(val total: Int, val pending: Int, val maxPosition: Double)
