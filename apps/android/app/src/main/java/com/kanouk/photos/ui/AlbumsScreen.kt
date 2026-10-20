package com.kanouk.photos.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kanouk.photos.data.Album

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlbumsScreen(vm: AppViewModel, snackbar: SnackbarHostState) {
	val uploads by vm.uploads.collectAsState()
	var creating by remember { mutableStateOf(false) }
	var menu by remember { mutableStateOf(false) }
	val scroll = TopAppBarDefaults.enterAlwaysScrollBehavior()
	Scaffold(
		modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
		topBar = {
			TopAppBar(
				title = { Text("アルバム", fontWeight = FontWeight.SemiBold) },
				scrollBehavior = scroll,
				actions = {
					IconButton(onClick = { creating = true }) { Icon(Glyph.Plus, "新しいアルバム") }
					Box {
						IconButton(onClick = { menu = true }) { Icon(Glyph.More, "メニュー") }
						DropdownMenu(menu, { menu = false }) {
							DropdownMenuItem(text = { Text(vm.session.baseUrl.removePrefix("https://"), color = MaterialTheme.colorScheme.onSurfaceVariant) }, onClick = {}, enabled = false)
							DropdownMenuItem(text = { Text("ログアウト") }, onClick = { menu = false; vm.signOut() })
						}
					}
				},
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background, scrolledContainerColor = MaterialTheme.colorScheme.background),
			)
		},
		floatingActionButton = {
			ExtendedFloatingActionButton(
				onClick = { vm.open(Screen.Picker(null)) },
				modifier = Modifier.semantics { contentDescription = "写真を追加" },
				icon = { Icon(Glyph.Upload, null) },
				text = { Text("写真を追加") },
			)
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		PullToRefreshBox(isRefreshing = vm.albumsLoading, onRefresh = vm::refreshAlbums, modifier = Modifier.fillMaxSize().padding(padding)) {
			LazyVerticalGrid(
				columns = GridCells.Adaptive(158.dp),
				contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 96.dp),
				horizontalArrangement = Arrangement.spacedBy(12.dp),
				verticalArrangement = Arrangement.spacedBy(18.dp),
				modifier = Modifier.fillMaxSize(),
			) {
				val active = uploads.filter { it.worthShowing }.takeLast(3)
				items(active, key = { "upload-${it.id}" }, span = { GridItemSpan(maxLineSpan) }) { batch ->
					UploadCard(batch, onRetry = { vm.retry(batch) }, onDismiss = { vm.dismiss(batch) }, onOpen = { vm.open(Screen.AlbumDetail(batch.albumId)) })
				}
				if (vm.albums.isEmpty() && !vm.albumsLoading) item(span = { GridItemSpan(maxLineSpan) }) {
					Text("アルバムがありません。右上の＋から作成できます。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 40.dp))
				}
				items(vm.albums, key = { it.id }) { album ->
					AlbumCard(album, vm.counts[album.id]?.total, vm.counts[album.id]?.pending ?: 0) { vm.open(Screen.AlbumDetail(album.id)) }
				}
			}
		}
	}
	if (creating) TextInputDialog(
		title = "新しいアルバム", label = "アルバムの名前（例：Kyoto, 2026/10）", confirm = "作成して写真を選ぶ",
		onDismiss = { creating = false },
		onConfirm = { title, _ -> creating = false; vm.createAlbum(title) { album -> vm.open(Screen.AlbumDetail(album.id)); vm.open(Screen.Picker(album.id)) } },
	)
}

@Composable
private fun AlbumCard(album: Album, total: Int?, pending: Int, onClick: () -> Unit) {
	Column(Modifier.clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		Box {
			RemoteImage(album.coverKey, 480, Modifier.fillMaxWidth().aspectRatio(1.5f).clip(RoundedCornerShape(14.dp)), source = album.coverSource)
			val state = when {
				!album.isPublished -> "下書き"
				album.hasPendingChanges || pending > 0 -> "未公開の変更"
				else -> null
			}
			if (state != null) Flag(state, if (album.isPublished) Color(0xE6B26A00) else Color(0xE6646970), Modifier.align(Alignment.TopStart).padding(8.dp))
		}
		Column(Modifier.padding(horizontal = 2.dp)) {
			Text(album.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
			Spacer(Modifier.height(2.dp))
			Text(
				listOfNotNull(total?.let { "${it}点" }, album.period).joinToString(" · "),
				style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
			)
		}
	}
}

