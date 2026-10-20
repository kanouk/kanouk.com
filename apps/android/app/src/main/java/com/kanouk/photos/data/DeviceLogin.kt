package com.kanouk.photos.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Sign in with EmDash's OAuth device flow: the app shows a short code, the owner
 * approves it in the browser where they are signed in to the admin. The app never
 * sees the password. "admin" is needed for the photo organizer's plugin routes.
 */
class DeviceLogin(private val http: OkHttpClient, private val baseUrl: String) {
	data class Code(val deviceCode: String, val userCode: String, val verificationUri: String, val intervalSeconds: Long, val expiresInSeconds: Long)
	data class Tokens(val access: String, val refresh: String, val expiresIn: Long)

	private val json = Json { ignoreUnknownKeys = true }
	private val type = "application/json".toMediaType()

	private suspend fun post(path: String, body: String): Pair<Int, String> = withContext(Dispatchers.IO) {
		val request = Request.Builder().url(baseUrl + path).header("X-EmDash-Request", "1").post(body.toRequestBody(type)).build()
		try { http.newCall(request).execute().use { it.code to it.body.string() } }
		catch (error: java.io.IOException) { throw ApiException(OFFLINE_MESSAGE) }
	}

	suspend fun start(): Code {
		val body = buildJsonObject {
			put("client_id", "kanolog-photos-android")
			put("scope", "content:read content:write media:read media:write admin")
		}
		val (status, text) = post("/_emdash/api/oauth/device/code", body.toString())
		val data = runCatching { json.parseToJsonElement(text).asObject()?.child("data") }.getOrNull()
		if (status !in 200..299 || data == null) throw ApiException("ログインを開始できませんでした（$status）。接続先を確かめてください。")
		return Code(
			deviceCode = data.string("device_code") ?: throw ApiException("応答が読めませんでした。"),
			userCode = data.string("user_code").orEmpty(),
			// The approval page of the server this app talks to (EmDash reports its configured public origin).
			verificationUri = "$baseUrl/_emdash/admin/device",
			intervalSeconds = data.number("interval")?.toLong() ?: 5,
			expiresInSeconds = data.number("expires_in")?.toLong() ?: 900,
		)
	}

	/** Ask once now (used when the app comes back from the browser). */
	val nudges = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)

	/**
	 * Polls until the owner approves (or denies, or the code expires). Network
	 * trouble while the app sits in the background (Android pauses it while the
	 * browser is open) does not end the wait; only a denial or expiry does.
	 */
	suspend fun awaitApproval(code: Code): Tokens {
		var interval = code.intervalSeconds
		val deadline = System.currentTimeMillis() + code.expiresInSeconds * 1000
		while (System.currentTimeMillis() < deadline) {
			kotlinx.coroutines.withTimeoutOrNull(interval * 1000) { nudges.receive() }
			val body = buildJsonObject {
				put("device_code", code.deviceCode)
				put("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
			}
			val (status, text) = try { post("/_emdash/api/oauth/device/token", body.toString()) } catch (error: ApiException) { continue }
			val payload = runCatching { json.parseToJsonElement(text).asObject() }.getOrNull()
			if (status in 200..299) {
				val data = payload?.child("data") ?: continue
				return Tokens(
					access = data.string("access_token") ?: continue,
					refresh = data.string("refresh_token") ?: continue,
					expiresIn = data.number("expires_in")?.toLong() ?: 3600,
				)
			}
			when (payload?.string("error")) {
				"slow_down" -> interval = payload.number("interval")?.toLong() ?: (interval + 5)
				"access_denied" -> throw ApiException("ブラウザで拒否されました。")
				"expired_token" -> throw ApiException("コードの有効期限（15分）が切れました。もう一度ログインしてください。")
				// authorization_pending, rate limits and server hiccups: keep waiting.
				else -> if (status == 429) interval += 5
			}
		}
		throw ApiException("コードの有効期限（15分）が切れました。もう一度ログインしてください。")
	}
}
