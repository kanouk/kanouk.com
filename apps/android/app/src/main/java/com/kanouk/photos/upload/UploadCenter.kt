package com.kanouk.photos.upload

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.kanouk.photos.media.LocalPhoto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

@Serializable
data class UploadItem(
	val uri: String,
	val name: String,
	val size: Long,
	val width: Int,
	val height: Int,
	val mimeType: String,
	val state: String = QUEUED,
	val error: String? = null,
	val photoId: String? = null,
	val locationErased: Boolean = false,
) {
	val uploadKey get() = "$name|$size"
	val settled get() = state == DONE || state == DUPLICATE || state == FAILED

	companion object {
		const val QUEUED = "queued"
		const val UPLOADING = "uploading"
		const val DONE = "done"
		const val DUPLICATE = "duplicate"
		const val FAILED = "failed"
	}
}

@Serializable
data class UploadBatch(
	val id: String,
	val albumId: String,
	val albumTitle: String,
	val items: List<UploadItem>,
	val finished: Boolean = false,
	val message: String? = null,
) {
	val done get() = items.count { it.state == UploadItem.DONE }
	val settled get() = items.count { it.settled }
	val failed get() = items.count { it.state == UploadItem.FAILED }
	val duplicates get() = items.count { it.state == UploadItem.DUPLICATE }
	val locationErased get() = items.count { it.locationErased }
	val running get() = !finished
	private val startedAt get() = id.substringBefore('-').toLongOrNull() ?: 0L
	/** Still worth showing: running, failed, or finished within the last half hour. */
	val worthShowing get() = running || failed > 0 || System.currentTimeMillis() - startedAt < 30 * 60 * 1000
}

/**
 * Upload batches, kept on disk so they survive the app being closed. The work
 * itself runs in [UploadWorker] as a foreground job; the UI watches [batches].
 */
object UploadCenter {
	const val CHANNEL = "uploads"
	private val json = Json { ignoreUnknownKeys = true }
	private lateinit var dir: File
	private val state = MutableStateFlow<List<UploadBatch>>(emptyList())
	val batches: StateFlow<List<UploadBatch>> = state.asStateFlow()

	fun init(context: Context) {
		dir = File(context.filesDir, "uploads").apply { mkdirs() }
		state.value = dir.listFiles { file -> file.extension == "json" }.orEmpty()
			.mapNotNull { runCatching { json.decodeFromString<UploadBatch>(it.readText()) }.getOrNull() }
			.sortedBy { it.id }
	}

	fun load(id: String): UploadBatch? = state.value.firstOrNull { it.id == id }

	@Synchronized
	fun save(batch: UploadBatch) {
		File(dir, "${batch.id}.json").writeText(json.encodeToString(UploadBatch.serializer(), batch))
		state.value = (state.value.filterNot { it.id == batch.id } + batch).sortedBy { it.id }
	}

	fun dismiss(batch: UploadBatch) {
		File(dir, "${batch.id}.json").delete()
		state.value = state.value.filterNot { it.id == batch.id }
	}

	fun enqueue(context: Context, albumId: String, albumTitle: String, photos: List<LocalPhoto>) {
		// Oldest first, like the web organizer: positions then follow the capture order.
		val items = photos.sortedBy { it.takenAt }.map {
			UploadItem(it.uri.toString(), it.name, it.size, it.width, it.height, it.mimeType)
		}
		val batch = UploadBatch("${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(6)}", albumId, albumTitle, items)
		save(batch)
		start(context, batch.id)
	}

	fun retry(context: Context, batch: UploadBatch) {
		save(batch.copy(finished = false, message = null, items = batch.items.map { if (it.state == UploadItem.FAILED) it.copy(state = UploadItem.QUEUED, error = null) else it }))
		start(context, batch.id)
	}

	private fun start(context: Context, id: String) {
		val request = OneTimeWorkRequestBuilder<UploadWorker>()
			.setInputData(workDataOf(UploadWorker.BATCH to id))
			.setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
			.addTag("upload")
			.build()
		WorkManager.getInstance(context).enqueueUniqueWork("upload-$id", ExistingWorkPolicy.KEEP, request)
	}
}
