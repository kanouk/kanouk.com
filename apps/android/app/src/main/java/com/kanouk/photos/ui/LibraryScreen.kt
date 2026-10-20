package com.kanouk.photos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kanouk.photos.data.Photo
import com.kanouk.photos.data.siteDay
import java.time.format.DateTimeFormatter
import java.util.Locale

private val LIBRARY_DAY = DateTimeFormatter.ofPattern("yyyy/MM/dd（E）", Locale.JAPANESE)

/** Photos under their capture day, in the order given (newest first). */
private fun byDay(photos: List<Photo>): List<Pair<String, List<Photo>>> {
	val groups = LinkedHashMap<String, MutableList<Photo>>()
	for (photo in photos) groups.getOrPut(siteDay(photo.capturedAt)?.format(LIBRARY_DAY) ?: "撮影日なし") { mutableListOf() } += photo
	return groups.map { it.key to it.value }
}

/** SmugMug's Library: every photo across the albums, newest capture first. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(vm: AppViewModel, snackbar: SnackbarHostState) {
	val library = vm.library
	val grid = rememberLazyGridState()
	val days = remember(library.photos) { byDay(library.photos) }
	LaunchedEffect(Unit) { if (!library.loaded) vm.loadLibrary() }
	LaunchedEffect(grid) {
		snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
			if (vm.library.loaded && last >= grid.layoutInfo.totalItemsCount - 30) vm.loadLibrary()
		}
	}
	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text("ライブラリ", fontWeight = FontWeight.SemiBold) },
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
			)
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		PullToRefreshBox(isRefreshing = library.loading && library.photos.isEmpty(), onRefresh = { vm.loadLibrary(refresh = true) }, modifier = Modifier.fillMaxSize().padding(padding)) {
			LazyVerticalGrid(
				state = grid,
				columns = GridCells.Fixed(3),
				contentPadding = PaddingValues(bottom = 16.dp),
				horizontalArrangement = Arrangement.spacedBy(2.dp),
				verticalArrangement = Arrangement.spacedBy(2.dp),
				modifier = Modifier.fillMaxSize(),
			) {
				if (library.loaded && library.photos.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
					Text("写真がありません", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(32.dp))
				}
				for ((day, photos) in days) {
					item(span = { GridItemSpan(maxLineSpan) }, key = "day-$day", contentType = "day") { DayHeader(day) }
					items(photos, key = { it.id }, contentType = { "photo" }) { photo -> LibraryTile(photo) { vm.openPhoto(photo) } }
				}
				if (library.loading && library.photos.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
					Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
				}
			}
			OpeningBar(vm.working)
		}
	}
}

@Composable
fun DayHeader(label: String) {
	Text(label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 18.dp, bottom = 8.dp))
}

@Composable
fun LibraryTile(photo: Photo, onClick: () -> Unit) {
	Box(Modifier.aspectRatio(1f).clickable(onClick = onClick)) {
		RemoteImage(photo.imageKey, 320, Modifier.fillMaxSize(), source = photo.imageSource)
		if (photo.hidden) Box(Modifier.fillMaxSize().background(Color(0x99111213)))
		// Only hidden photos are marked here; new uploads are drafts and would flag the whole grid.
		if (photo.hidden) Flag("非公開", stateTone(photo), Modifier.align(Alignment.TopEnd).padding(5.dp))
	}
}

/** A thin bar while a photo's album is read before the viewer opens. */
@Composable
fun OpeningBar(working: String?) {
	if (working != null) LinearProgressIndicator(Modifier.fillMaxWidth())
}
