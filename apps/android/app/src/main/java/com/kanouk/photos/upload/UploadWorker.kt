package com.kanouk.photos.upload

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.kanouk.photos.AppGraph
import com.kanouk.photos.MainActivity
import com.kanouk.photos.data.SignedOutException
import com.kanouk.photos.data.string
import com.kanouk.photos.media.openOriginal
import com.kanouk.photos.media.readExif
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.time.Instant

/** Uploads one batch: original file (EXIF kept) → media library → draft photo in the album. */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
	companion object {
		const val BATCH = "batch"
		private const val NOTIFICATION_PROGRESS = 41
	}

	private val notifications = context.getSystemService(NotificationManager::class.java)

	private fun notification(batch: UploadBatch, ongoing: Boolean): android.app.Notification {
		val open = PendingIntent.getActivity(
			applicationContext, 0,
			Intent(applicationContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
			PendingIntent.FLAG_IMMUTABLE,
		)
		val title = if (ongoing) "「${batch.albumTitle}」に追加中" else "「${batch.albumTitle}」に${batch.done}点を追加しました"
		val text = when {
			ongoing -> "${batch.settled} / ${batch.items.size}点"
			batch.failed > 0 -> "${batch.failed}点が失敗しました。アプリから再試行できます。"
			else -> "公開するまでサイトには出ません。"
		}
		return NotificationCompat.Builder(applicationContext, UploadCenter.CHANNEL)
			.setSmallIcon(android.R.drawable.stat_sys_upload)
			.setContentTitle(title)
			.setContentText(text)
			.setContentIntent(open)
			.setOnlyAlertOnce(true)
			.setOngoing(ongoing)
			.apply { if (ongoing) setProgress(batch.items.size, batch.settled, false) else setSmallIcon(android.R.drawable.stat_sys_upload_done) }
			.build()
	}

	private suspend fun showProgress(batch: UploadBatch) {
		setForeground(ForegroundInfo(NOTIFICATION_PROGRESS, notification(batch, true), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC))
	}

	override suspend fun doWork(): Result {
		val id = inputData.getString(BATCH) ?: return Result.failure()
		var batch = UploadCenter.load(id) ?: return Result.success()
		val api = AppGraph.api
		fun update(index: Int, change: (UploadItem) -> UploadItem) {
			batch = batch.copy(items = batch.items.toMutableList().also { it[index] = change(it[index]) })
			UploadCenter.save(batch)
		}
		showProgress(batch)

		val existing = try { api.allAlbumPhotos(batch.albumId) } catch (error: SignedOutException) {
			UploadCenter.save(batch.copy(finished = true, message = "ログインし直してから再試行してください。"))
			return Result.failure()
		} catch (error: Exception) {
			return if (runAttemptCount < 3) Result.retry() else {
				UploadCenter.save(batch.copy(finished = true, message = error.message)); Result.failure()
			}
		}
		val keys = existing.mapNotNull { it.uploadKey }.toMutableSet()
		val hashes = existing.mapNotNull { it.contentHash }.toMutableSet()
		var position = existing.maxOfOrNull { it.position } ?: 0.0
		val captured = mutableListOf<String>()
		val created = mutableListOf<String>()
		var firstImage: kotlinx.serialization.json.JsonObject? = null

		for (index in batch.items.indices) {
			val item = batch.items[index]
			if (item.state != UploadItem.QUEUED && item.state != UploadItem.UPLOADING) continue
			if (item.uploadKey in keys) { update(index) { it.copy(state = UploadItem.DUPLICATE) }; continue }
			update(index) { it.copy(state = UploadItem.UPLOADING, error = null) }
			showProgress(batch)
			try {
				val uri = Uri.parse(item.uri)
				val exif = applicationContext.readExif(uri)
				val body = object : RequestBody() {
					override fun contentType(): MediaType = item.mimeType.toMediaType()
					override fun writeTo(sink: BufferedSink) {
						val input = applicationContext.openOriginal(uri) ?: error("写真を読めませんでした")
						input.source().use { sink.writeAll(it) }
					}
				}
				val media = api.uploadMedia(body, item.name, item.width, item.height)
				val hash = media.string("contentHash")
				if (hash != null && hash in hashes) { update(index) { it.copy(state = UploadItem.DUPLICATE) }; continue }
				position += 1
				val photo = api.createPhoto(media, batch.albumId, position, exif, item.uploadKey)
				keys += item.uploadKey
				hash?.let(hashes::add)
				exif.capturedAt?.let(captured::add)
				created += photo.id
				if (firstImage == null) firstImage = photo.image
				update(index) { it.copy(state = UploadItem.DONE, photoId = photo.id, locationErased = exif.locationErased) }
			} catch (error: SignedOutException) {
				update(index) { it.copy(state = UploadItem.FAILED, error = error.message) }
				break
			} catch (error: Exception) {
				update(index) { it.copy(state = UploadItem.FAILED, error = error.message ?: "失敗しました") }
			}
		}

		// Widen the album's capture period to cover the new photos (as the web organizer does),
		// and give an album without a cover its first new photo. Both stay drafts until published.
		if (created.isNotEmpty()) runCatching {
			val (album, rev) = api.content("albums", batch.albumId)
			val data = album["data"] as? kotlinx.serialization.json.JsonObject
			fun instant(value: String?) = value?.let { runCatching { Instant.parse(it) }.getOrNull() }
			val times = captured.mapNotNull(::instant).sorted()
			val from = instant(data?.string("captured_from"))
			val to = instant(data?.string("captured_to"))
			val patch = buildJsonObject {
				if (data?.get("cover_image") !is kotlinx.serialization.json.JsonObject) firstImage?.let { put("cover_image", it) }
				times.firstOrNull()?.let { if (from == null || it < from) put("captured_from", it.toString()) }
				times.lastOrNull()?.let { if (to == null || it > to) put("captured_to", it.toString()) }
			}
			if (patch.isNotEmpty()) api.updateDraft("albums", batch.albumId, rev, patch)
		}
		api.recordOperation("photo-upload", if (batch.failed > 0) "partial" else "complete", created, batch.albumId)
		batch = batch.copy(finished = true)
		UploadCenter.save(batch)
		notifications.notify(batch.id.hashCode(), notification(batch, false))
		return Result.success()
	}
}
