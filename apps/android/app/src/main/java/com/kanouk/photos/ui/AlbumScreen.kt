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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.RadioButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import com.kanouk.photos.data.Album
import com.kanouk.photos.data.Photo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlbumScreen(vm: AppViewModel, albumId: String, snackbar: SnackbarHostState) {
	val context = LocalContext.current
	val haptics = LocalHapticFeedback.current
	val density = LocalDensity.current
	val album = vm.album(albumId)
	val state = vm.photos[albumId]
	val uploads by vm.uploads.collectAsState()
	val photos = state?.photos.orEmpty()
	var selected by remember(albumId) { mutableStateOf(setOf<String>()) }
	/** Selection mode stays on with nothing chosen when entered from the menu (as in SmugMug). */
	var selectMode by remember(albumId) { mutableStateOf(false) }
	var dragBase by remember { mutableStateOf(setOf<String>()) }
	var menu by remember { mutableStateOf(false) }
	var renaming by remember { mutableStateOf(false) }
	var sorting by remember { mutableStateOf(false) }
	var confirmDelete by remember { mutableStateOf(false) }
	/** The photos in their new order while a manual move is being made and saved. */
	var arranged by remember(albumId) { mutableStateOf<List<Photo>?>(null) }
	val shown = arranged ?: photos
	val grid = rememberLazyGridState()
	val selecting = selectMode || selected.isNotEmpty()
	val manual = album?.manualSort == true
	val canArrange = manual && selecting
	/** The order when the move started; pages loaded meanwhile do not take part. */
	var arrangeBase by remember(albumId) { mutableStateOf<List<Photo>>(emptyList()) }
	fun endSelection() { selected = emptySet(); selectMode = false }

	val currentPhotos by rememberUpdatedState(photos)
	val currentAlbum by rememberUpdatedState(album)
	val reorder = remember(grid, albumId) {
		GridReorder(
			grid,
			movable = { key -> currentPhotos.any { it.id == key } },
			onStart = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); arrangeBase = currentPhotos; arranged = currentPhotos },
			onMove = { from, to ->
				arranged = arranged?.let { list ->
					val a = list.indexOfFirst { it.id == from }
					val b = list.indexOfFirst { it.id == to }
					if (a < 0 || b < 0) list else list.toMutableList().apply { add(b, removeAt(a)) }
				}
			},
			onEnd = {
				val after = arranged
				val target = currentAlbum
				if (after == null || target == null || after.map { it.id } == arrangeBase.map { it.id }) arranged = null
				else vm.savePhotoOrder(target, arrangeBase, after) { arranged = null }
			},
		)
	}
	/** The ≡ handle sits in the middle of each tile; a long-press there moves the photo instead of selecting. */
	fun handleAt(point: Offset): Boolean {
		if (!canArrange) return false
		val item = reorder.itemAt(point)?.takeIf { item -> photos.any { it.id == item.key } } ?: return false
		val centre = Offset(item.offset.x + item.size.width / 2f, item.offset.y + item.size.height / 2f)
		return (point - centre).getDistance() <= with(density) { 26.dp.toPx() }
	}

	LaunchedEffect(albumId) { if (state?.loaded != true) vm.loadAlbum(albumId) }
	BackHandler(enabled = selecting) { endSelection() }
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
	val total = state?.total ?: photos.size

	Scaffold(
		contentWindowInsets = WindowInsets(0, 0, 0, 0),
		bottomBar = {
			AnimatedVisibility(selecting) {
				BottomAppBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
					Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
						val anyHidden = selectedPhotos.any { it.hidden }
						val ready = selected.isNotEmpty() && vm.working == null
						ActionButton(if (anyHidden) Glyph.Show else Glyph.Hide, if (anyHidden) "再び公開" else "非公開", enabled = ready) {
							vm.setHidden(album, selectedPhotos, hidden = !anyHidden) { endSelection() }
						}
						ActionButton(Glyph.Star, "表紙にする", enabled = selected.size == 1 && vm.working == null) {
							selectedPhotos.firstOrNull()?.let { vm.makeCover(album, it) }; endSelection()
						}
						ActionButton(Glyph.Trash, "削除", enabled = ready, tint = MaterialTheme.colorScheme.error) { confirmDelete = true }
					}
				}
			}
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		Box(Modifier.fillMaxSize().padding(bottom = padding.calculateBottomPadding())) {
			PullToRefreshBox(isRefreshing = state?.loading == true && photos.isEmpty(), onRefresh = { vm.loadAlbum(albumId); vm.refreshAlbums() }, modifier = Modifier.fillMaxSize()) {
				LazyVerticalGrid(
					state = grid,
					columns = GridCells.Adaptive(112.dp),
					contentPadding = PaddingValues(bottom = if (selecting) 24.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 24.dp),
					horizontalArrangement = Arrangement.spacedBy(2.dp),
					verticalArrangement = Arrangement.spacedBy(2.dp),
					modifier = Modifier.fillMaxSize()
						.reorderGesture(reorder, enabled = canArrange, startAt = ::handleAt)
						.dragToSelect(
							grid,
							keyAt = { key -> shown.indexOfFirst { it.id == key }.takeIf { it >= 0 } },
							onStart = { index ->
								haptics.performHapticFeedback(HapticFeedbackType.LongPress)
								selectMode = true
								dragBase = selected
								selected = selected + shown[index].id
							},
							onRange = { from, to ->
								val range = if (from <= to) from..to else to..from
								selected = dragBase + shown.slice(range).map { it.id }
							},
							skipAt = ::handleAt,
						),
				) {
					item(span = { GridItemSpan(maxLineSpan) }, key = "hero") {
						AlbumHero(album, albumState(album, pendingCount), total)
					}
					item(span = { GridItemSpan(maxLineSpan) }, key = "about") {
						AlbumAbout(album.description, album.isPublished, needsPublish && total > 0, pendingCount, vm.working) { vm.publishAlbum(album) }
					}
					myUploads.forEach { batch ->
						item(span = { GridItemSpan(maxLineSpan) }, key = "upload-${batch.id}") {
							Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) { UploadCard(batch, onRetry = { vm.retry(batch) }, onDismiss = { vm.dismiss(batch) }) }
						}
					}
					if (selecting && photos.size > 1) item(span = { GridItemSpan(maxLineSpan) }, key = "sort-hint") {
						Text(
							when {
								!manual -> "並べ替えるには、並べ替えで「手動」を選んでください"
								else -> "≡ を長押しして、置きたい場所まで動かします"
							},
							style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
							modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
						)
					}
					if (state?.loaded == true && photos.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
						Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
							Text("まだ写真がありません", style = MaterialTheme.typography.titleMedium)
							Text("撮影日時と位置情報はそのまま送ります。", color = MaterialTheme.colorScheme.onSurfaceVariant)
							Button(onClick = { vm.open(Screen.Picker(albumId)) }) { Text("写真を選ぶ") }
						}
					}
					itemsIndexed(shown, key = { _, photo -> photo.id }) { _, photo ->
						PhotoTile(
							photo, isCover = coverKey != null && coverKey == photo.imageKey,
							selecting = selecting, selected = photo.id in selected, handle = canArrange,
							modifier = reorderItem(reorder, photo.id),
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
			val solid by remember { derivedStateOf { grid.firstVisibleItemIndex > 0 } }
			if (selecting) TopAppBar(
				title = { Text(if (selected.isEmpty()) "写真を選択" else "${selected.size}点を選択") },
				navigationIcon = { IconButton(onClick = { endSelection() }) { Icon(Glyph.Close, "選択を終える") } },
				actions = {
					TextButtonSmall(if (selected.size == photos.size && photos.isNotEmpty()) "選択を解除" else "すべて選択") {
						selected = if (selected.size == photos.size) emptySet() else photos.map { it.id }.toSet()
					}
				},
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
			) else TopAppBar(
				title = { if (solid) Text(album.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
				navigationIcon = { IconButton(onClick = { vm.back() }) { Icon(Glyph.Back, "戻る", tint = Color.White) } },
				actions = {
					IconButton(onClick = { vm.open(Screen.Picker(albumId)) }) { Icon(Glyph.Plus, "写真を追加", tint = Color.White) }
					Box {
						IconButton(onClick = { menu = true }) { Icon(Glyph.More, "メニュー", tint = Color.White) }
						DropdownMenu(menu, { menu = false }) {
							DropdownMenuItem(text = { Text("写真を選択") }, leadingIcon = { Icon(Glyph.Select, null) }, enabled = photos.isNotEmpty(), onClick = { menu = false; selectMode = true })
							DropdownMenuItem(text = { Text("並べ替え") }, leadingIcon = { Icon(Glyph.Sort, null) }, onClick = { menu = false; sorting = true })
							DropdownMenuItem(text = { Text("アルバムの設定") }, leadingIcon = { Icon(Glyph.Edit, null) }, onClick = { menu = false; renaming = true })
							if (album.isPublished && album.slug != null) DropdownMenuItem(
								text = { Text("公開ページを開く") }, leadingIcon = { Icon(Glyph.Globe, null) },
								onClick = { menu = false; context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${photoSite(vm.session.baseUrl)}/albums/${album.slug}"))) },
							)
						}
					}
				},
				// Transparent over the cover photo; solid once the cover has scrolled away.
				colors = TopAppBarDefaults.topAppBarColors(
					containerColor = if (solid) MaterialTheme.colorScheme.background else Color.Transparent,
					titleContentColor = Color.White,
				),
			)
		}
	}

	if (renaming) AlbumSettingsDialog(album, onDismiss = { renaming = false }) { title, description -> renaming = false; vm.renameAlbum(album, title, description) }
	if (sorting) SortDialog(album.sortMethod, album.sortDirection, onDismiss = { sorting = false }) { method, direction ->
		sorting = false
		if (method != album.sortMethod || direction != album.sortDirection) vm.setAlbumSort(album, method, direction)
	}
	if (confirmDelete) ConfirmDialog(
		title = "${selected.size}点を削除しますか？", text = "管理画面のゴミ箱から戻せます。", confirm = "削除",
		onDismiss = { confirmDelete = false },
		onConfirm = { confirmDelete = false; vm.trash(album, selectedPhotos) { endSelection() } },
	)
}

/** SmugMug-like cover: the album's cover photo with the title over a dark fade. */
@Composable
private fun AlbumHero(album: Album, status: String, total: Int) {
	Box(Modifier.fillMaxWidth().aspectRatio(1.6f)) {
		RemoteImage(album.coverKey, 1200, Modifier.fillMaxSize(), source = album.coverSource)
		Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color(0x66000000), 0.3f to Color.Transparent, 0.55f to Color.Transparent, 1f to Color(0xD9000000))))
		Column(Modifier.align(Alignment.BottomStart).padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
			Text(
				album.title, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis,
				style = MaterialTheme.typography.headlineMedium.merge(TextStyle(shadow = PhotoTextShadow)),
			)
			Text(
				listOfNotNull(status, "${total}点", album.period).joinToString(" · "),
				color = Color(0xE6FFFFFF), style = MaterialTheme.typography.bodyMedium.merge(TextStyle(shadow = PhotoTextShadow)),
			)
		}
	}
}

@Composable
private fun AlbumAbout(description: String, published: Boolean, needsPublish: Boolean, pending: Int, working: String?, onPublish: () -> Unit) {
	if (description.isBlank() && !needsPublish) return
	Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
		if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
		if (needsPublish) Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
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

/** SmugMug's "Sort By" with ascending/descending. Values are what the site stores. */
private val SORT_METHODS = listOf(
	"date taken" to "撮影日時",
	"position" to "手動",
	"filename" to "ファイル名",
	"caption" to "キャプション",
	"date uploaded" to "追加日",
	"date modified" to "更新日",
)

@Composable
private fun SortDialog(method: String, direction: String, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
	var chosen by remember { mutableStateOf(method.takeIf { m -> SORT_METHODS.any { it.first == m } } ?: "date taken") }
	var order by remember { mutableStateOf(if (direction == "desc") "desc" else "asc") }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("並べ替え") },
		text = {
			Column {
				for ((value, label) in SORT_METHODS) ChoiceRow(label, chosen == value) { chosen = value }
				HorizontalDivider(Modifier.padding(vertical = 8.dp))
				ChoiceRow("古い順（昇順）", order == "asc") { order = "asc" }
				ChoiceRow("新しい順（降順）", order == "desc") { order = "desc" }
			}
		},
		confirmButton = { TextButton(onClick = { onSave(chosen, order) }) { Text("保存") } },
		dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
	)
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).selectable(selected, role = Role.RadioButton, onClick = onClick).padding(vertical = 2.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		RadioButton(selected = selected, onClick = null, modifier = Modifier.padding(horizontal = 8.dp, vertical = 10.dp))
		Text(label, style = MaterialTheme.typography.bodyLarge)
	}
}

@Composable
private fun PhotoTile(photo: Photo, isCover: Boolean, selecting: Boolean, selected: Boolean, handle: Boolean, modifier: Modifier, onClick: () -> Unit) {
	Box(modifier.aspectRatio(1f).background(MaterialTheme.colorScheme.background).clickable(onClick = onClick)) {
		RemoteImage(photo.imageKey, 320, Modifier.fillMaxSize().then(if (selected) Modifier.padding(10.dp).clip12() else Modifier), source = photo.imageSource)
		if (photo.hidden) Box(Modifier.fillMaxSize().background(Color(0x99111213)))
		Row(Modifier.align(Alignment.TopEnd).padding(5.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
			if (isCover) Flag("表紙")
			photo.stateLabel?.let { Flag(it, stateTone(photo)) }
		}
		if (selecting) SquareCheck(selected, Modifier.align(Alignment.TopStart).padding(6.dp))
		if (handle) Box(Modifier.align(Alignment.Center).size(36.dp).background(Color(0x8C000000), CircleShape), contentAlignment = Alignment.Center) {
			Icon(Glyph.Handle, "長押しして動かす", tint = Color.White, modifier = Modifier.size(20.dp))
		}
		if (selected) Box(Modifier.fillMaxSize().border(2.dp, MaterialTheme.colorScheme.primary))
	}
}

/** SmugMug's square check box on each tile in selection mode. */
@Composable
private fun SquareCheck(checked: Boolean, modifier: Modifier = Modifier) {
	Box(
		modifier.size(22.dp).clip(RoundedCornerShape(4.dp))
			.background(if (checked) MaterialTheme.colorScheme.primary else Color(0x4D000000))
			.border(2.dp, if (checked) MaterialTheme.colorScheme.primary else Color.White, RoundedCornerShape(4.dp)),
		contentAlignment = Alignment.Center,
	) {
		if (checked) Icon(Glyph.Check, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(16.dp))
	}
}

private fun Modifier.clip12() = this.clip(RoundedCornerShape(8.dp))

@Composable
private fun TextButtonSmall(text: String, onClick: () -> Unit) = androidx.compose.material3.TextButton(onClick = onClick) { Text(text) }

/** blog.kanouk.com → photos.kanouk.com; other hosts (development) serve both. */
fun photoSite(base: String): String = base.replace("://blog.", "://photos.").replace("://blog-staging.", "://photos-staging.")
