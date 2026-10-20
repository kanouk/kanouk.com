package com.kanouk.photos.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kanouk.photos.AppGraph
import com.kanouk.photos.data.Album
import com.kanouk.photos.data.AlbumCount
import com.kanouk.photos.data.DeviceLogin
import com.kanouk.photos.data.Photo
import com.kanouk.photos.data.SignedOutException
import com.kanouk.photos.media.LocalPhoto
import com.kanouk.photos.upload.UploadBatch
import com.kanouk.photos.upload.UploadCenter
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

sealed interface Screen {
	data object Login : Screen
	data object Albums : Screen
	data class AlbumDetail(val albumId: String) : Screen
	/** Choosing photos on the phone; [albumId] null means "choose the album afterwards". */
	data class Picker(val albumId: String?) : Screen
	data class Viewer(val albumId: String, val photoId: String) : Screen
}

data class AlbumPhotos(val photos: List<Photo> = emptyList(), val total: Int = 0, val nextOffset: Int? = null, val loading: Boolean = false, val loaded: Boolean = false)

sealed interface LoginState {
	data object Idle : LoginState
	data object Starting : LoginState
	data class Waiting(val code: DeviceLogin.Code) : LoginState
	data class Failed(val message: String) : LoginState
}

class AppViewModel(app: Application) : AndroidViewModel(app) {
	private val api = AppGraph.api
	private val actions = AppGraph.actions
	val session = AppGraph.session

	val stack = mutableStateListOf<Screen>(if (session.signedIn) Screen.Albums else Screen.Login)
	val screen get() = stack.last()
	fun open(screen: Screen) { stack += screen }
	fun back(): Boolean = if (stack.size > 1) { stack.removeAt(stack.lastIndex); true } else false
	private fun resetTo(screen: Screen) { stack.clear(); stack += screen }

	var albums by mutableStateOf<List<Album>>(emptyList()); private set
	var counts by mutableStateOf<Map<String, AlbumCount>>(emptyMap()); private set
	var albumsLoading by mutableStateOf(false); private set
	var photos by mutableStateOf<Map<String, AlbumPhotos>>(emptyMap()); private set
	/** A short message for the snackbar. */
	var notice by mutableStateOf<String?>(null)
	/** Set while an operation runs (its label), to block repeated taps. */
	var working by mutableStateOf<String?>(null); private set
	var login by mutableStateOf<LoginState>(LoginState.Idle); private set
	val uploads: StateFlow<List<UploadBatch>> = UploadCenter.batches
	private var loginJob: Job? = null
	private var deviceLogin: DeviceLogin? = null
	/** Back from the browser: check the approval right away instead of waiting for the next poll. */
	fun checkLoginNow() { deviceLogin?.nudges?.trySend(Unit) }
	/**
	 * Lists carry the published version of a photo; a single read carries its draft.
	 * Keep the draft read until the list reports another draft revision.
	 */
	private val drafts = mutableMapOf<String, Photo>()
	private fun overlay(list: List<Photo>) = list.map { listed -> drafts[listed.id]?.takeIf { it.draftRevisionId == listed.draftRevisionId } ?: listed.also { drafts.remove(it.id) } }

	private suspend fun refreshPhotoDraft(photoId: String) {
		val (item, _) = api.content("photos", photoId)
		val draft = Photo.from(item)
		drafts[photoId] = draft
		photos = photos.mapValues { (_, state) -> state.copy(photos = state.photos.map { if (it.id == photoId) draft else it }) }
	}

	init {
		if (session.signedIn) refreshAlbums()
		// Refresh what an upload changed once it finishes.
		viewModelScope.launch {
			val seen = mutableSetOf<String>()
			uploads.collect { batches ->
				for (batch in batches.filter { it.finished && it.id !in seen }) {
					seen += batch.id
					if (batch.done > 0) { loadAlbum(batch.albumId); refreshAlbums() }
				}
				seen.addAll(batches.filter { it.finished }.map { it.id })
			}
		}
	}

	fun album(id: String) = albums.firstOrNull { it.id == id }

	private fun guard(label: String? = null, block: suspend () -> Unit) {
		viewModelScope.launch {
			if (label != null) working = label
			try { block() }
			catch (error: SignedOutException) { notice = error.message; signOut() }
			catch (error: Exception) { notice = error.message ?: "うまくいきませんでした" }
			finally { if (label != null) working = null }
		}
	}

	// ---- Sign in ---------------------------------------------------------------

	fun startLogin(baseUrl: String) {
		session.baseUrl = baseUrl.trim().ifEmpty { com.kanouk.photos.data.Session.DEFAULT_BASE_URL }
		loginJob?.cancel()
		login = LoginState.Starting
		loginJob = viewModelScope.launch {
			try {
				val flow = DeviceLogin(api.http, session.baseUrl).also { deviceLogin = it }
				val code = flow.start()
				login = LoginState.Waiting(code)
				val tokens = flow.awaitApproval(code)
				session.saveTokens(tokens.access, tokens.expiresIn, tokens.refresh)
				login = LoginState.Idle
				resetTo(Screen.Albums)
				refreshAlbums()
			} catch (error: kotlinx.coroutines.CancellationException) {
				throw error
			} catch (error: Exception) {
				login = LoginState.Failed(error.message ?: "ログインできませんでした（${error::class.simpleName}）")
			}
		}
	}

	fun cancelLogin() { loginJob?.cancel(); login = LoginState.Idle }

	fun signOut() {
		session.clear()
		albums = emptyList(); photos = emptyMap(); counts = emptyMap()
		resetTo(Screen.Login)
	}

	// ---- Albums -----------------------------------------------------------------

	fun refreshAlbums() = guard {
		albumsLoading = true
		try {
			albums = overlayAlbums(api.albums())
			counts = runCatching { api.albumCounts() }.getOrDefault(counts)
		} finally { albumsLoading = false }
	}

	/** The album as being edited (its draft): lists show the published version. */
	private val albumDrafts = mutableMapOf<String, Album>()
	private fun overlayAlbums(list: List<Album>) = list.map { listed -> albumDrafts[listed.id]?.takeIf { it.draftRevisionId == listed.draftRevisionId } ?: listed.also { albumDrafts.remove(it.id) } }

	private suspend fun refreshAlbumDraft(albumId: String) {
		val (item, _) = api.content("albums", albumId)
		val draft = Album.from(item)
		albumDrafts[albumId] = draft
		albums = albums.map { if (it.id == albumId) draft else it }
	}

	fun loadAlbum(albumId: String) = guard {
		runCatching { refreshAlbumDraft(albumId) }
		photos = photos + (albumId to (photos[albumId] ?: AlbumPhotos()).copy(loading = true))
		try {
			val page = api.photoPage(albumId)
			photos = photos + (albumId to AlbumPhotos(overlay(page.items), page.total, page.nextOffset, loading = false, loaded = true))
		} finally {
			photos[albumId]?.let { if (it.loading) photos = photos + (albumId to it.copy(loading = false)) }
		}
	}

	fun loadMore(albumId: String) {
		val current = photos[albumId] ?: return
		val offset = current.nextOffset ?: return
		if (current.loading) return
		photos = photos + (albumId to current.copy(loading = true))
		guard {
			try {
				val page = api.photoPage(albumId, offset)
				val known = current.photos.map { it.id }.toSet()
				photos = photos + (albumId to current.copy(photos = current.photos + overlay(page.items.filter { it.id !in known }), total = page.total, nextOffset = page.nextOffset, loading = false))
			} finally {
				photos[albumId]?.let { if (it.loading) photos = photos + (albumId to it.copy(loading = false)) }
			}
		}
	}

	private suspend fun reloadAfterChange(albumId: String) {
		val all = api.allAlbumPhotos(albumId)
		photos = photos + (albumId to AlbumPhotos(overlay(all), all.size, null, loading = false, loaded = true))
		albums = overlayAlbums(api.albums())
		runCatching { refreshAlbumDraft(albumId) }
		counts = runCatching { api.albumCounts() }.getOrDefault(counts)
	}

	fun createAlbum(title: String, then: (Album) -> Unit) = guard("アルバムを作成中…") {
		val album = api.createAlbum(title.trim())
		albums = listOf(album) + albums
		then(album)
	}

	fun renameAlbum(album: Album, title: String, description: String) = guard("保存中…") {
		actions.renameAlbum(album, title.trim(), description.trim())
		refreshAlbumDraft(album.id)
		notice = "保存しました。「公開」でサイトに反映されます"
	}

	fun publishAlbum(album: Album) = guard("公開しています…") {
		val count = actions.publishAlbum(album)
		reloadAfterChange(album.id)
		notice = if (count > 0) "アルバムと写真${count}点を公開しました" else "アルバムを公開しました"
	}

	fun setHidden(album: Album, targets: List<Photo>, hidden: Boolean, done: () -> Unit = {}) = guard(if (hidden) "非公開にしています…" else "公開しています…") {
		var failed = 0
		for (photo in targets) runCatching { actions.setHidden(photo, hidden) }.onFailure { failed++ }
		reloadAfterChange(album.id)
		notice = when {
			failed > 0 -> "${targets.size - failed}点を処理・${failed}点が失敗しました"
			hidden -> "${targets.size}点を非公開にしました"
			else -> "${targets.size}点を公開しました"
		}
		done()
	}

	fun trash(album: Album, targets: List<Photo>, done: () -> Unit = {}) = guard("削除しています…") {
		var failed: String? = null
		var removed = 0
		for (photo in targets) runCatching { actions.trash(album, photo); removed++ }.onFailure { failed = it.message }
		reloadAfterChange(album.id)
		notice = failed?.let { "${removed}点を削除しました。$it" } ?: "${removed}点を削除しました（管理画面のゴミ箱から戻せます）"
		done()
	}

	fun makeCover(album: Album, photo: Photo) = guard("表紙を変更中…") {
		actions.makeCover(album, photo)
		refreshAlbumDraft(album.id)
		notice = "表紙にしました。「公開」でサイトに反映されます"
	}

	fun editPhoto(album: Album, photo: Photo, title: String, caption: String, done: () -> Unit = {}) = guard("保存中…") {
		actions.editPhoto(photo, title.trim(), caption.trim())
		reloadAfterChange(album.id)
		refreshPhotoDraft(photo.id)
		notice = "保存しました。「公開」でサイトに反映されます"
		done()
	}

	// ---- Uploads ----------------------------------------------------------------

	fun upload(album: Album, chosen: List<LocalPhoto>) {
		if (chosen.isEmpty()) return
		UploadCenter.enqueue(getApplication(), album.id, album.title, chosen)
		notice = "${chosen.size}点の追加を始めました。アプリを閉じても続きます"
	}

	fun retry(batch: UploadBatch) = UploadCenter.retry(getApplication(), batch)
	fun dismiss(batch: UploadBatch) = UploadCenter.dismiss(batch)
}
