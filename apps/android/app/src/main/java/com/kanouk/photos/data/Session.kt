package com.kanouk.photos.data

import android.content.Context

/**
 * Where the app is signed in, and its OAuth tokens (EmDash device flow).
 * Kept in the app's private storage; signing out removes them.
 */
class Session(context: Context) {
	private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

	var baseUrl: String
		get() = prefs.getString("base_url", null) ?: DEFAULT_BASE_URL
		set(value) = prefs.edit().putString("base_url", value.trimEnd('/')).apply()

	val accessToken: String? get() = prefs.getString("access_token", null)
	val accessExpiresAt: Long get() = prefs.getLong("access_expires_at", 0)
	val refreshToken: String? get() = prefs.getString("refresh_token", null)
	val signedIn: Boolean get() = refreshToken != null

	fun saveTokens(access: String, expiresInSeconds: Long, refresh: String?) {
		prefs.edit()
			.putString("access_token", access)
			.putLong("access_expires_at", System.currentTimeMillis() + expiresInSeconds * 1000)
			.apply { if (refresh != null) putString("refresh_token", refresh) }
			.apply()
	}

	fun clear() {
		prefs.edit().remove("access_token").remove("access_expires_at").remove("refresh_token").apply()
	}

	companion object {
		const val DEFAULT_BASE_URL = "https://blog.kanouk.com"
	}
}
