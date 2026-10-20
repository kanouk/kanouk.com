package com.kanouk.photos.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kanouk.photos.data.Photo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlbumScreen(vm: AppViewModel, albumId: String, snackbar: SnackbarHostState) {
	val context = LocalContext.current
	val haptics = LocalHapticFeedback.current
	val album = vm.album(albumId)
	val state = vm.photos[albumId]
	val uploads by vm.uploads.collectAsState()
	val photos = state?.photos.orEmpty()
	var selected by remember(albumId) { mutableStateOf(setOf<String>()) }
	var dragBase by remember { mutableStateOf(setOf<String>()) }
	var menu by remember { mutableStateOf(false) }
	var renaming by remember { mutableStateOf(false) }
	var confirmDelete by remember { mutableStateOf(false) }
	val grid = rememberLazyGridState()
	val selecting = selected.isNotEmpty()

	LaunchedEffect(albumId) { if (state?.loaded != true) vm.loadAlbum(albumId) }
	BackHandler(enabled = selecting) { selected = emptySet() }
	// Load the next page when the end of the grid comes near.
	LaunchedEffect(grid, albumId) {
		snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
			if (last >= grid.layoutInfo.totalItemsCount - 12) vm.loadMore(albumId)
		}
	}
	if (album == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }; return }

	val selectedPhotos = photos.filter { it.id in selected }
	val pendingCount = maxOf(photos.count { it.hasPendingChanges }, vm.counts[albumId]?.pending ?: 0)
	val needsPublish = !album.isPublished || album.hasPendingChanges || pendingCount > 0
	val myUploads = uploads.filter { it.albumId == albumId && it.worthShowing }
	val coverKey = album.coverKey
	val headerCount = 1 + myUploads.size

	Scaffold(
		topBar = {
			if (selecting) TopAppBar(
				title = { Text("${selected.size}点を選択") },
				navigationIcon = { IconButton(onClick = { selected = emptySet() }) { Icon(Glyph.Close, "選択を解除") } },
				actions = {
					TextButtonSmall(if (selected.size == photos.size) "選択を解除" else "すべて選択") {
						selected = if (selected.size == photos.size) emptySet() else photos.map { it.id }.toSet()
					}
				},
			) else TopAppBar(
				title = {
					val collapsed by remember { derivedStateOf { grid.firstVisibleItemIndex > 0 } }
					if (collapsed) Text(album.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
				},
				navigationIcon = { IconButton(onClick = { vm.back() }) { Icon(Glyph.Back, "アルバム一覧") } },
				actions = {
					Box {
						IconButton(onClick = { menu = true }) { Icon(Glyph.More, "メニュー") }
						DropdownMenu(menu, { menu = false }) {
							DropdownMenuItem(text = { Text("名前と説明を編集") }, leadingIcon = { Icon(Glyph.Edit, null) }, onClick = { menu = false; renaming = true })
							if (album.isPublished && album.slug != null) DropdownMenuItem(
								text = { Text("公開ページを開く") }, leadingIcon = { Icon(Glyph.Globe, null) },
								onClick = { menu = false; context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${photoSite(vm.session.baseUrl)}/albums/${album.slug}"))) },
							)
						}
					}
				},
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
			)
		},
		bottomBar = {
			AnimatedVisibility(selecting) {
				BottomAppBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
					Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
						val anyHidden = selectedPhotos.any { it.hidden }
						ActionButton(if (anyHidden) Glyph.Show else Glyph.Hide, if (anyHidden) "再び公開" else "非公開", enabled = vm.working == null) {
							vm.setHidden(album, selectedPhotos, hidden = !anyHidden) { selected = emptySet() }
						}
						ActionButton(Glyph.Star, "表紙にする", enabled = selected.size == 1 && vm.working == null) {
							selectedPhotos.firstOrNull()?.let { vm.makeCover(album, it) }; selected = emptySet()
						}
						ActionButton(Glyph.Trash, "削除", enabled = vm.working == null, tint = MaterialTheme.colorScheme.error) { confirmDelete = true }
					}
				}
			}
		},
		floatingActionButton = {
			if (!selecting) ExtendedFloatingActionButton(onClick = { vm.open(Screen.Picker(albumId)) }, modifier = Modifier.semantics { contentDescription = "写真を追加" }, icon = { Icon(Glyph.Plus, null) }, text = { Text("追加") })
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		PullToRefreshBox(isRefreshing = state?.loading == true && photos.isEmpty(), onRefresh = { vm.loadAlbum(albumId); vm.refreshAlbums() }, modifier = Modifier.fillMaxSize().padding(padding)) {
			LazyVerticalGrid(
				state = grid,
				columns = GridCells.Adaptive(112.dp),
				contentPadding = PaddingValues(bottom = 96.dp),
				horizontalArrangement = Arrangement.spacedBy(2.dp),
				verticalArrangement = Arrangement.spacedBy(2.dp),
				modifier = Modifier.fillMaxSize().dragToSelect(
					grid,
					keyAt = { key -> photos.indexOfFirst { it.id == key }.takeIf { it >= 0 } },
					onStart = { index ->
						haptics.performHapticFeedback(HapticFeedbackType.LongPress)
						dragBase = selected
						selected = selected + photos[index].id
					},
					onRange = { from, to ->
						val range = if (from <= to) from..to else to..from
						selected = dragBase + photos.slice(range).map { it.id }
					},
				),
			) {
				item(span = { GridItemSpan(maxLineSpan) }, key = "header") {
					AlbumHeader(album.title, album.description, album.isPublished, state?.total ?: photos.size, album.period, needsPublish, pendingCount, vm.working) { vm.publishAlbum(album) }
				}
				myUploads.forEach { batch ->
					item(span = { GridItemSpan(maxLineSpan) }, key = "upload-${batch.id}") {
						Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) { UploadCard(batch, onRetry = { vm.retry(batch) }, onDismiss = { vm.dismiss(batch) }) }
					}
				}
				if (state?.loaded == true && photos.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
					Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
						Text("まだ写真がありません", style = MaterialTheme.typography.titleMedium)
						Text("撮影日時と位置情報はそのまま送ります。", color = MaterialTheme.colorScheme.onSurfaceVariant)
						Button(onClick = { vm.open(Screen.Picker(albumId)) }) { Text("写真を選ぶ") }
					}
				}
				itemsIndexed(photos, key = { _, photo -> photo.id }) { _, photo ->
					PhotoTile(
						photo, isCover = coverKey != null && coverKey == photo.imageKey,
						selecting = selecting, selected = photo.id in selected,
						onClick = {
							if (selecting) selected = if (photo.id in selected) selected - photo.id else selected + photo.id
							else vm.open(Screen.Viewer(albumId, photo.id))
						},
					)
				}
				if (state?.loading == true && photos.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
					Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.padding(4.dp)) }
				}
			}
		}
	}

	if (renaming) TextInputDialog(
		title = "アルバムの名前と説明", label = "名前", initial = album.title, confirm = "保存",
		secondLabel = "説明", secondInitial = album.description,
		onDismiss = { renaming = false },
		onConfirm = { title, description -> renaming = false; vm.renameAlbum(album, title, description) },
	)
	if (confirmDelete) ConfirmDialog(
		title = "${selected.size}点を削除しますか？", text = "管理画面のゴミ箱から戻せます。", confirm = "削除",
		onDismiss = { confirmDelete = false },
		onConfirm = { confirmDelete = false; vm.trash(album, selectedPhotos) { selected = emptySet() } },
	)
}

@Composable
private fun AlbumHeader(title: String, description: String, published: Boolean, total: Int, period: String?, needsPublish: Boolean, pending: Int, working: String?, onPublish: () -> Unit) {
	Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
		Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
			Text(if (published) "公開中" else "下書き", color = if (published) Color(0xFF1E7A4F) else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
			Text(listOfNotNull("${total}点", period).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
		}
		if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
		if (needsPublish && total > 0) Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) {
			Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
				Text(
					if (!published) "下書きです。公開するとサイトに出ます" else "未公開の変更${if (pending > 0) " ${pending}件" else ""}があります",
					style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.weight(1f),
				)
				Button(onClick = onPublish, enabled = working == null) { Text(working ?: if (published) "変更を公開" else "公開する") }
			}
		}
	}
}

@Composable
private fun PhotoTile(photo: Photo, isCover: Boolean, selecting: Boolean, selected: Boolean, onClick: () -> Unit) {
	Box(Modifier.aspectRatio(1f).clickable(onClick = onClick)) {
		RemoteImage(photo.imageKey, 320, Modifier.fillMaxSize().then(if (selected) Modifier.padding(10.dp).clip12() else Modifier), source = photo.imageSource)
		if (photo.hidden) Box(Modifier.fillMaxSize().background(Color(0x99FFFFFF)))
		Row(Modifier.align(Alignment.TopEnd).padding(5.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
			if (isCover) Flag("表紙")
			photo.stateLabel?.let { Flag(it, stateTone(photo)) }
		}
		if (selecting) SelectionMark(selected, modifier = Modifier.align(Alignment.TopStart).padding(6.dp))
		if (selected) Box(Modifier.fillMaxSize().border(2.dp, MaterialTheme.colorScheme.primary))
	}
}

private fun Modifier.clip12() = this.clip(RoundedCornerShape(8.dp))

@Composable
private fun TextButtonSmall(text: String, onClick: () -> Unit) = androidx.compose.material3.TextButton(onClick = onClick) { Text(text) }

/** blog.kanouk.com → photos.kanouk.com; other hosts (development) serve both. */
fun photoSite(base: String): String = base.replace("://blog.", "://photos.").replace("://blog-staging.", "://photos-staging.")
