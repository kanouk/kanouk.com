package com.kanouk.photos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kanouk.photos.data.Album
import kotlinx.coroutines.delay

/** SmugMug's Search: recent albums when empty; matching albums and photos while typing. */
@Composable
fun SearchScreen(vm: AppViewModel, snackbar: SnackbarHostState) {
	val query = vm.searchQuery.trim()
	// Wait for a pause in typing before asking the server.
	LaunchedEffect(query) { if (query.isNotEmpty()) delay(300); vm.search(query) }
	val albums = if (query.isEmpty()) emptyList() else vm.albums.filter { it.title.contains(query, ignoreCase = true) }
	val recent = vm.recentAlbumIds.mapNotNull(vm::album)
	Scaffold(
		topBar = {
			TextField(
				vm.searchQuery, { vm.searchQuery = it },
				placeholder = { Text("アルバムと写真を検索") },
				leadingIcon = { Icon(Glyph.Search, null) },
				trailingIcon = { if (vm.searchQuery.isNotEmpty()) IconButton(onClick = { vm.searchQuery = "" }) { Icon(Glyph.Close, "検索語を消す") } },
				singleLine = true,
				shape = RoundedCornerShape(28.dp),
				colors = TextFieldDefaults.colors(
					focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
					focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
				),
				modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
			)
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		Box(Modifier.fillMaxSize().padding(padding)) {
			LazyVerticalGrid(
				columns = GridCells.Fixed(3),
				contentPadding = PaddingValues(bottom = 16.dp),
				horizontalArrangement = Arrangement.spacedBy(2.dp),
				verticalArrangement = Arrangement.spacedBy(2.dp),
				modifier = Modifier.fillMaxSize(),
			) {
				if (query.isEmpty()) {
					if (recent.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }, key = "recent") {
						Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
							Text("最近見たアルバム", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
							TextButton(onClick = vm::clearRecent) { Text("クリア") }
						}
					} else item(span = { GridItemSpan(maxLineSpan) }) {
						Text("アルバムの名前や写真のタイトル・キャプションで探せます。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
					}
					items(recent, key = { "recent-${it.id}" }, span = { GridItemSpan(maxLineSpan) }) { album -> AlbumBanner(album) { vm.open(Screen.AlbumDetail(album.id)) } }
				} else {
					if (albums.isNotEmpty()) {
						item(span = { GridItemSpan(maxLineSpan) }, key = "albums") { SectionLabel("アルバム") }
						items(albums, key = { "album-${it.id}" }, span = { GridItemSpan(maxLineSpan) }) { album -> AlbumBanner(album) { vm.open(Screen.AlbumDetail(album.id)) } }
					}
					if (vm.searchResults.isNotEmpty()) {
						item(span = { GridItemSpan(maxLineSpan) }, key = "photos") { SectionLabel("写真") }
						items(vm.searchResults, key = { it.id }) { photo -> LibraryTile(photo) { vm.openPhoto(photo) } }
					}
					if (albums.isEmpty() && vm.searchResults.isEmpty() && !vm.searching) item(span = { GridItemSpan(maxLineSpan) }) {
						Text("見つかりませんでした", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
					}
				}
			}
			OpeningBar(vm.working ?: if (vm.searching) "検索中" else null)
		}
	}
}

@Composable
private fun SectionLabel(text: String) {
	Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp))
}

/** A wide, darkened cover with the album title on it (SmugMug's search rows). */
@Composable
private fun AlbumBanner(album: Album, onClick: () -> Unit) {
	Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp).fillMaxWidth().aspectRatio(4.6f).clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick)) {
		RemoteImage(album.coverKey, 960, Modifier.fillMaxSize(), source = album.coverSource)
		Box(Modifier.fillMaxSize().background(Color(0x80000000)))
		Row(Modifier.align(Alignment.CenterStart).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
			Icon(Glyph.Album, null, tint = Color.White, modifier = Modifier.size(22.dp))
			Spacer(Modifier.width(10.dp))
			Text(
				album.title, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis,
				style = MaterialTheme.typography.titleMedium.merge(TextStyle(shadow = PhotoTextShadow)),
			)
		}
	}
}
