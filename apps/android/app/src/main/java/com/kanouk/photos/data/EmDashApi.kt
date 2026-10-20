package com.kanouk.photos.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.time.Instant
import java.util.concurrent.TimeUnit

class ApiException(message: String, val code: String? = null, val status: Int = 0) : Exception(message)
class SignedOutException : Exception("ログインし直してください。")

private val JSON_TYPE = "application/json".toMediaType()
private const val PLUGIN = "/_emdash/api/plugins/yohaku-photo-tools"
const val OFFLINE_MESSAGE = "サーバーにつながりませんでした。通信状態を確かめてください。"

/** The parts of EmDash's admin API that the photo organizer uses, with OAuth bearer tokens. */
class EmDashApi(private val session: Session) {
	val http: OkHttpClient = OkHttpClient.Builder()
		.connectTimeout(20, TimeUnit.SECONDS)
		.readTimeout(120, TimeUnit.SECONDS)
		.writeTimeout(10, TimeUnit.MINUTES)
		.build()
	private val json = Json { ignoreUnknownKeys = true }
	private val refreshLock = Mutex()

	val baseUrl get() = session.baseUrl

	/** A valid access token, refreshed with the 90-day refresh token when it is about to expire. */
	suspend fun accessToken(forceRefresh: Boolean = false): String = refreshLock.withLock {
		val current = session.accessToken
		if (!forceRefresh && current != null && session.accessExpiresAt > System.currentTimeMillis() + 60_000) return current
		val refresh = session.refreshToken ?: throw SignedOutException()
		val body = buildJsonObject { put("refresh_token", refresh); put("grant_type", "refresh_token") }
		val response = execute(Request.Builder().url("$baseUrl/_emdash/api/oauth/token/refresh").post(body.toString().toRequestBody(JSON_TYPE)).build())
		if (response.first == 400 || response.first == 401) { session.clear(); throw SignedOutException() }
		val data = unwrap(response)
		val access = data.asObject()?.string("access_token") ?: throw ApiException("トークンを更新できませんでした。")
		val expires = data.asObject()?.number("expires_in")?.toLong() ?: 3600
		session.saveTokens(access, expires, data.asObject()?.string("refresh_token"))
		access
	}

	private suspend fun execute(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
		try {
			http.newCall(request.newBuilder().header("X-EmDash-Request", "1").build()).execute().use { it.code to it.body.string() }
		} catch (error: java.io.IOException) {
			throw ApiException(OFFLINE_MESSAGE)
		}
	}

	private fun unwrap(response: Pair<Int, String>): JsonElement {
		val (status, text) = response
		val payload = runCatching { json.parseToJsonElement(text).asObject() }.getOrNull()
		val data = payload?.get("data")
		if (status !in 200..299 || payload?.flag("success") != true || data == null) {
			val error = payload?.child("error")
			throw ApiException(error?.string("message") ?: "通信に失敗しました（$status）", error?.string("code"), status)
		}
		return data
	}

	private suspend fun call(method: String, path: String, body: RequestBody? = null): JsonElement {
		suspend fun attempt(token: String) = execute(
			Request.Builder().url(baseUrl + path).header("Authorization", "Bearer $token").method(method, body).build(),
		)
		var response = attempt(accessToken())
		if (response.first == 401) response = attempt(accessToken(forceRefresh = true))
		return unwrap(response)
	}

	private suspend fun get(path: String) = call("GET", path)
	private suspend fun send(method: String, path: String, data: JsonObject? = null) =
		call(method, path, (data ?: JsonObject(emptyMap())).toString().toRequestBody(JSON_TYPE))

	// ---- Albums and photos -------------------------------------------------

	suspend fun me(): JsonObject? = get("/_emdash/api/auth/me").asObject()

	suspend fun albums(): List<Album> {
		val albums = mutableListOf<Album>()
		var cursor: String? = null
		do {
			val query = "limit=100&orderBy=captured_from&order=desc" + (cursor?.let { "&cursor=${encode(it)}" } ?: "")
			val page = get("/_emdash/api/content/albums?$query").asObject()
			(page?.get("items") as? JsonArray)?.mapNotNull { it.asObject()?.let(Album::from) }?.let(albums::addAll)
			cursor = page?.string("nextCursor")
		} while (cursor != null)
		// Albums still being put together (drafts) first, then newest first.
		return albums.filter { !it.isPublished } + albums.filter { it.isPublished }
	}

	suspend fun albumCounts(): Map<String, AlbumCount> {
		val items = get("$PLUGIN/album-counts").asObject()?.get("items") as? JsonArray ?: return emptyMap()
		return items.mapNotNull { it.asObject() }.associate {
			(it.string("album") ?: "") to AlbumCount(it.number("total")?.toInt() ?: 0, it.number("pending")?.toInt() ?: 0, it.number("maxPosition") ?: 0.0)
		}
	}

	data class PhotoPage(val items: List<Photo>, val total: Int, val nextOffset: Int?)

	suspend fun photoPage(albumId: String, offset: Int = 0): PhotoPage {
		val page = get("$PLUGIN/photo-page?album=${encode(albumId)}&q=&filter=&offset=$offset&photo=").asObject()
		val items = (page?.get("items") as? JsonArray)?.mapNotNull { it.asObject()?.let(Photo::from) }.orEmpty()
		return PhotoPage(items, page?.number("total")?.toInt() ?: items.size, page?.number("nextOffset")?.toInt())
	}

	suspend fun allAlbumPhotos(albumId: String): List<Photo> {
		val photos = mutableListOf<Photo>()
		var offset: Int? = 0
		while (offset != null) {
			val page = photoPage(albumId, offset)
			photos += page.items
			offset = page.nextOffset
		}
		return photos
	}

	data class PhotoList(val items: List<Photo>, val nextCursor: String?)

	/** Photos across all albums (the Library and search); list items carry each photo's listed data. */
	suspend fun photos(query: String, cursor: String? = null): PhotoList {
		val page = get("/_emdash/api/content/photos?$query" + (cursor?.let { "&cursor=${encode(it)}" } ?: "")).asObject()
		val items = (page?.get("items") as? JsonArray)?.mapNotNull { it.asObject()?.let(Photo::from) }.orEmpty()
		return PhotoList(items, page?.string("nextCursor"))
	}

	suspend fun library(cursor: String?) = photos("limit=100&orderBy=captured_at&order=desc", cursor)
	suspend fun searchPhotos(text: String) = photos("q=${encode(text)}&limit=60").items

	/** The owner's album order (shared with the public album list); empty until saved once. */
	suspend fun albumOrder(): List<String> = ids(get("$PLUGIN/album-order"))

	suspend fun saveAlbumOrder(ids: List<String>): List<String> =
		ids(send("POST", "$PLUGIN/album-order", buildJsonObject { put("ids", JsonArray(ids.map(::JsonPrimitive))) }))

	private fun ids(data: JsonElement) = (data.asObject()?.get("ids") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

	/** The item and its edit revision (needed to save a draft). */
	suspend fun content(collection: String, id: String): Pair<JsonObject, String> {
		val envelope = get("/_emdash/api/content/$collection/${encode(id)}?locale=ja").asObject() ?: throw ApiException("読み込めませんでした。")
		val item = envelope.child("item") ?: throw ApiException("読み込めませんでした。")
		return item to (envelope.string("_rev") ?: item.string("_rev") ?: "")
	}

	suspend fun updateDraft(collection: String, id: String, rev: String, data: JsonObject): JsonObject =
		send("PUT", "/_emdash/api/content/$collection/${encode(id)}?locale=ja", buildJsonObject { put("data", data); put("_rev", rev) })
			.asObject()?.child("item") ?: throw ApiException("保存できませんでした。")

	suspend fun publish(collection: String, id: String) { send("POST", "/_emdash/api/content/$collection/${encode(id)}/publish?locale=ja") }
	suspend fun unpublish(collection: String, id: String) { send("POST", "/_emdash/api/content/$collection/${encode(id)}/unpublish?locale=ja") }

	/** EmDash's trash: restorable from the admin. */
	suspend fun trash(collection: String, id: String) { call("DELETE", "/_emdash/api/content/$collection/${encode(id)}?locale=ja") }

	suspend fun createAlbum(title: String): Album {
		val data = buildJsonObject {
			put("title", title)
			put("description", "")
			put("sort_method", "position")
			put("sort_direction", "asc")
			put("allow_downloads", false)
			putJsonObject("source_metadata") { put("photo_organizer_created", true); put("android_app", true) }
		}
		val item = send("POST", "/_emdash/api/content/albums", buildJsonObject { put("data", data); put("status", "draft"); put("locale", "ja") })
			.asObject()?.child("item") ?: throw ApiException("アルバムを作れませんでした。")
		return Album.from(item)
	}

	/** Upload one file to the media library; returns EmDash's media item. */
	suspend fun uploadMedia(file: RequestBody, filename: String, width: Int, height: Int): JsonObject {
		val body = MultipartBody.Builder().setType(MultipartBody.FORM)
			.addFormDataPart("file", filename, file)
			.apply { if (width > 0 && height > 0) { addFormDataPart("width", width.toString()); addFormDataPart("height", height.toString()) } }
			.build()
		return call("POST", "/_emdash/api/media", body).asObject()?.child("item") ?: throw ApiException("アップロードの応答が読めませんでした。")
	}

	/** Same fields as the web organizer's createPhotoFromMedia, so both stay interchangeable. */
	suspend fun createPhoto(media: JsonObject, albumId: String, position: Double, exif: PhotoExif, uploadKey: String): Photo {
		val filename = media.string("filename") ?: "photo.jpg"
		val title = filename.substringBeforeLast('.').replace(Regex("[_-]+"), " ").trim().ifEmpty { "写真" }
		val mime = media.string("mimeType") ?: "image/jpeg"
		val data = buildJsonObject {
			put("title", title)
			putJsonObject("image") {
				media.string("id")?.let { put("id", it) }
				media.string("url")?.let { put("src", it); put("url", it) }
				put("filename", filename)
				put("mimeType", mime)
				media.number("width")?.let { put("width", it.toInt()) }
				media.number("height")?.let { put("height", it.toInt()) }
				media.string("blurhash")?.let { put("blurhash", it) }
				media.string("dominantColor")?.let { put("dominantColor", it) }
				media.string("storageKey")?.let { key -> putJsonObject("meta") { put("storageKey", key) } }
			}
			put("kind", if (mime.startsWith("video/")) "video" else "image")
			put("alt", title)
			put("caption", "")
			put("album", albumId)
			put("position", position.toLong())
			exif.capturedAt?.let { put("captured_at", it) }
			if (exif.latitude != null && exif.longitude != null) {
				put("latitude", exif.latitude)
				put("longitude", exif.longitude)
				exif.altitude?.let { put("altitude", it) }
			}
			put("source_system", "photo-organizer")
			media.string("id")?.let { put("source_id", it) }
			putJsonObject("source_metadata") {
				put("photo_organizer_upload", true)
				put("android_app", true)
				put("uploaded_at", Instant.now().toString())
				// The owner keeps EXIF (capture time and location); unwanted photos are hidden or deleted.
				put("location_review", "kept")
				put("upload_key", uploadKey)
				media.string("contentHash")?.let { put("content_hash", it) }
			}
		}
		val item = send("POST", "/_emdash/api/content/photos", buildJsonObject { put("data", data); put("status", "draft"); put("locale", "ja") })
			.asObject()?.child("item") ?: throw ApiException("写真を登録できませんでした。")
		return Photo.from(item)
	}

	suspend fun recordOperation(kind: String, status: String, targetIds: List<String>, albumId: String) {
		runCatching {
			send("POST", "$PLUGIN/operations", buildJsonObject {
				put("action", "record"); put("kind", kind); put("status", status)
				put("targetIds", JsonArray(targetIds.map(::JsonPrimitive)))
				putJsonObject("metadata") { put("albumId", albumId); put("client", "android") }
			})
		}
	}

	private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}

data class PhotoExif(val capturedAt: String?, val latitude: Double?, val longitude: Double?, val altitude: Double?, val locationErased: Boolean = false)
