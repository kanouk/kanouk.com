package com.kanouk.photos

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import coil3.svg.SvgDecoder
import com.kanouk.photos.data.EmDashApi
import com.kanouk.photos.data.PhotoActions
import com.kanouk.photos.data.Session
import com.kanouk.photos.upload.UploadCenter
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor

/** Shared services for the activity and the upload worker. */
object AppGraph {
	lateinit var session: Session; private set
	lateinit var api: EmDashApi; private set
	lateinit var actions: PhotoActions; private set

	fun init(app: Application) {
		if (::session.isInitialized) return
		session = Session(app)
		api = EmDashApi(session)
		actions = PhotoActions(api)
	}
}

class KanologApp : Application(), SingletonImageLoader.Factory {
	override fun onCreate() {
		super.onCreate()
		AppGraph.init(this)
		UploadCenter.init(this)
		getSystemService(NotificationManager::class.java).createNotificationChannel(
			NotificationChannel(UploadCenter.CHANNEL, "写真のアップロード", NotificationManager.IMPORTANCE_LOW),
		)
	}

	/** Thumbnails of draft photos are private: send the bearer token to the site, never elsewhere. */
	override fun newImageLoader(context: PlatformContext): ImageLoader {
		val auth = Interceptor { chain ->
			val request = chain.request()
			val site = runCatching { java.net.URI(AppGraph.session.baseUrl).host }.getOrNull()
			if (site != null && request.url.host == site && AppGraph.session.signedIn) {
				val token = runCatching { runBlocking { AppGraph.api.accessToken() } }.getOrNull()
				chain.proceed(if (token != null) request.newBuilder().header("Authorization", "Bearer $token").build() else request)
			} else chain.proceed(request)
		}
		val client = AppGraph.api.http.newBuilder().addInterceptor(auth).build()
		return ImageLoader.Builder(context)
			.components {
				add(OkHttpNetworkFetcherFactory(callFactory = { client }))
				add(SvgDecoder.Factory())
			}
			.crossfade(true)
			.build()
	}
}
