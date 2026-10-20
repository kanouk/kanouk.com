package com.kanouk.photos.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.kanouk.photos.data.Album

const val SITE_NAME = "カノログ フォト"

/** White text on photos stays readable over bright skies. */
val PhotoTextShadow = Shadow(Color(0xB3000000), blurRadius = 8f)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlbumsScreen(vm: AppViewModel, snackbar: SnackbarHostState) {
	val context = LocalContext.current
	val haptics = LocalHapticFeedback.current
	val uploads by vm.uploads.collectAsState()
	var creating by remember { mutableStateOf(false) }
	var addMenu by remember { mutableStateOf(false) }
	var siteMenu by remember { mutableStateOf(false) }
	var account by remember { mutableStateOf(false) }
	var renaming by remember { mutableStateOf<Album?>(null) }
	/** Non-null while sorting: the albums in the order being arranged. */
	var arranging by remember { mutableStateOf<List<Album>?>(null) }
	val grid = rememberLazyGridState()
	val shown = arranging ?: vm.albums
	val reorder = remember(grid) {
		GridReorder(
			grid,
			movable = { key -> arranging?.any { it.id == key } == true },
			onStart = { haptics.performHapticFeedback(HapticFeedbackType.LongPress) },
			onMove = { from, to ->
				arranging = arranging?.let { list ->
					val a = list.indexOfFirst { it.id == from }
					val b = list.indexOfFirst { it.id == to }
					if (a < 0 || b < 0) list else list.toMutableList().apply { add(b, removeAt(a)) }
				}
			},
			onEnd = {},
		)
	}
	BackHandler(enabled = arranging != null) { arranging = null }

	Scaffold(
		topBar = {
			if (arranging != null) TopAppBar(
				title = { Text("並べ替え", fontWeight = FontWeight.SemiBold) },
				navigationIcon = { IconButton(onClick = { arranging = null }) { Icon(Glyph.Close, "並べ替えをやめる") } },
				actions = {
					TextButton(onClick = { arranging?.let { list -> vm.saveAlbumOrder(list) { arranging = null } } }, enabled = vm.working == null) {
						Text(if (vm.working != null) "保存中…" else "完了")
					}
				},
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
			) else TopAppBar(
				title = {},
				navigationIcon = {
					Box {
						IconButton(onClick = { account = true }) { SiteMark() }
						DropdownMenu(account, { account = false }) {
							DropdownMenuItem(text = { Text(vm.session.baseUrl.removePrefix("https://"), color = MaterialTheme.colorScheme.onSurfaceVariant) }, onClick = {}, enabled = false)
							DropdownMenuItem(text = { Text("ログアウト") }, onClick = { account = false; vm.signOut() })
						}
					}
				},
				actions = {
					Box {
						IconButton(onClick = { addMenu = true }) { Icon(Glyph.Plus, "追加") }
						DropdownMenu(addMenu, { addMenu = false }) {
							DropdownMenuItem(text = { Text("写真") }, leadingIcon = { Icon(Glyph.Image, null) }, onClick = { addMenu = false; vm.open(Screen.Picker(null)) })
							DropdownMenuItem(text = { Text("アルバム") }, leadingIcon = { Icon(Glyph.Album, null) }, onClick = { addMenu = false; creating = true })
						}
					}
					Box {
						IconButton(onClick = { siteMenu = true }) { Icon(Glyph.More, "メニュー") }
						DropdownMenu(siteMenu, { siteMenu = false }) {
							DropdownMenuItem(
								text = { Text("並べ替え") }, leadingIcon = { Icon(Glyph.Sort, null) }, enabled = vm.albums.size > 1,
								onClick = { siteMenu = false; arranging = vm.albums },
							)
						}
					}
				},
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
			)
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		PullToRefreshBox(isRefreshing = vm.albumsLoading, onRefresh = { if (arranging == null) vm.refreshAlbums() }, modifier = Modifier.fillMaxSize().padding(padding)) {
			LazyVerticalGrid(
				state = grid,
				columns = GridCells.Fixed(2),
				contentPadding = PaddingValues(start = 10.dp, end = 10.dp, bottom = 24.dp),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp),
				modifier = Modifier.fillMaxSize().reorderGesture(reorder, enabled = arranging != null),
			) {
				if (arranging != null) item(span = { GridItemSpan(maxLineSpan) }, key = "hint") {
					Text("長押しして、置きたい場所まで動かします。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 6.dp, vertical = 8.dp))
				} else {
					item(span = { GridItemSpan(maxLineSpan) }, key = "hero") {
						val first = vm.albums.firstOrNull { it.coverKey != null || it.coverSource != null } ?: vm.albums.firstOrNull()
						SiteHero(first, Modifier.fullBleed(10.dp))
					}
					val active = uploads.filter { it.worthShowing }.takeLast(3)
					items(active, key = { "upload-${it.id}" }, span = { GridItemSpan(maxLineSpan) }) { batch ->
						UploadCard(batch, onRetry = { vm.retry(batch) }, onDismiss = { vm.dismiss(batch) }, onOpen = { vm.open(Screen.AlbumDetail(batch.albumId)) })
					}
					if (vm.albums.isEmpty() && !vm.albumsLoading) item(span = { GridItemSpan(maxLineSpan) }) {
						Text("アルバムがありません。右上の＋から作成できます。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 40.dp, horizontal = 6.dp))
					}
				}
				items(shown, key = { it.id }) { album ->
					val count = vm.counts[album.id]
					AlbumCard(
						album, count?.total, count?.pending ?: 0,
						arranging = arranging != null,
						modifier = reorderItem(reorder, album.id),
						onSettings = { renaming = album },
						onOpenSite = album.slug?.takeIf { album.isPublished }?.let { slug ->
							{ context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${photoSite(vm.session.baseUrl)}/albums/$slug"))) }
						},
					) { if (arranging == null) vm.open(Screen.AlbumDetail(album.id)) }
				}
			}
		}
	}
	if (creating) TextInputDialog(
		title = "新しいアルバム", label = "アルバムの名前（例：Kyoto, 2026/10）", confirm = "作成して写真を選ぶ",
		onDismiss = { creating = false },
		onConfirm = { title, _ -> creating = false; vm.createAlbum(title) { album -> vm.open(Screen.AlbumDetail(album.id)); vm.open(Screen.Picker(album.id)) } },
	)
	renaming?.let { album ->
		AlbumSettingsDialog(album, onDismiss = { renaming = null }) { title, description -> renaming = null; vm.renameAlbum(album, title, description) }
	}
}

/** The avatar-like round mark at the top left (SmugMug shows the owner's photo there). */
@Composable
private fun SiteMark() {
	Box(Modifier.size(32.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).semantics { contentDescription = "アカウント" }, contentAlignment = Alignment.Center) {
		Text("カ", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
	}
}

@Composable
private fun SiteHero(album: Album?, modifier: Modifier = Modifier) {
	Box(modifier.fillMaxWidth().aspectRatio(16f / 9f).padding(bottom = 6.dp)) {
		RemoteImage(album?.coverKey, 1200, Modifier.fillMaxSize(), source = album?.coverSource)
		Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color(0xCC000000))))
		Text(
			SITE_NAME, color = Color.White, fontWeight = FontWeight.Bold,
			style = MaterialTheme.typography.headlineSmall.merge(TextStyle(shadow = PhotoTextShadow)),
			modifier = Modifier.align(Alignment.BottomStart).padding(start = 16.dp, bottom = 14.dp),
		)
	}
}

/** Album status as one short line: 公開中 / 下書き / 未公開の変更. */
fun albumState(album: Album, pending: Int): String = when {
	!album.isPublished -> "下書き"
	album.hasPendingChanges || pending > 0 -> "未公開の変更"
	else -> "公開中"
}

@Composable
private fun AlbumCard(
	album: Album, total: Int?, pending: Int, arranging: Boolean, modifier: Modifier,
	onSettings: () -> Unit, onOpenSite: (() -> Unit)?, onClick: () -> Unit,
) {
	var menu by remember { mutableStateOf(false) }
	Box(modifier.aspectRatio(1.45f).clip(RoundedCornerShape(6.dp)).clickable(enabled = !arranging, onClick = onClick)) {
		RemoteImage(album.coverKey, 480, Modifier.fillMaxSize(), source = album.coverSource)
		Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Color(0xB3000000))))
		Column(Modifier.align(Alignment.BottomStart).padding(start = 10.dp, end = 10.dp, bottom = 9.dp)) {
			Text(
				album.title, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis,
				style = MaterialTheme.typography.titleSmall.merge(TextStyle(shadow = PhotoTextShadow)),
			)
			Spacer(Modifier.height(1.dp))
			Text(
				listOfNotNull(albumState(album, pending), total?.let { "${it}点" }).joinToString(" · "),
				color = Color(0xD9FFFFFF), maxLines = 1,
				style = MaterialTheme.typography.labelSmall.merge(TextStyle(shadow = PhotoTextShadow)),
			)
		}
		if (arranging) Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(32.dp).background(Color(0x99000000), CircleShape), contentAlignment = Alignment.Center) {
			Icon(Glyph.Handle, "長押しして動かす", tint = Color.White, modifier = Modifier.size(20.dp))
		} else Box(Modifier.align(Alignment.TopEnd)) {
			IconButton(onClick = { menu = true }) {
				Box(Modifier.size(28.dp).background(Color(0x66000000), CircleShape), contentAlignment = Alignment.Center) {
					Icon(Glyph.Ellipsis, "「${album.title}」のメニュー", tint = Color.White, modifier = Modifier.size(20.dp))
				}
			}
			DropdownMenu(menu, { menu = false }) {
				DropdownMenuItem(text = { Text("アルバムの設定") }, leadingIcon = { Icon(Glyph.Edit, null) }, onClick = { menu = false; onSettings() })
				if (onOpenSite != null) DropdownMenuItem(text = { Text("公開ページを開く") }, leadingIcon = { Icon(Glyph.Globe, null) }, onClick = { menu = false; onOpenSite() })
			}
		}
	}
}

@Composable
fun AlbumSettingsDialog(album: Album, onDismiss: () -> Unit, onSave: (String, String) -> Unit) = TextInputDialog(
	title = "アルバムの設定", label = "名前", initial = album.title, confirm = "保存",
	secondLabel = "説明", secondInitial = album.description,
	onDismiss = onDismiss, onConfirm = onSave,
)

/** Let a full-width grid row reach the screen edges past the grid's side padding. */
fun Modifier.fullBleed(side: Dp): Modifier = layout { measurable, constraints ->
	val extra = (side * 2).roundToPx()
	val width = constraints.maxWidth + extra
	val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
	layout(constraints.maxWidth, placeable.height) { placeable.place(-extra / 2, 0) }
}
