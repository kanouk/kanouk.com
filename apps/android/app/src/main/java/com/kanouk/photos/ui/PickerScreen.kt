package com.kanouk.photos.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.kanouk.photos.data.Album
import com.kanouk.photos.media.LocalGallery
import com.kanouk.photos.media.LocalPhoto
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val DAY_HEADER = DateTimeFormatter.ofPattern("yyyy/MM/dd（E）", Locale.JAPANESE)

private sealed interface PickerRow {
	data class Day(val label: String, val photos: List<LocalPhoto>) : PickerRow
	data class Item(val photo: LocalPhoto, val index: Int) : PickerRow
}

private fun mediaPermissions(): Array<String> = buildList {
	if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.READ_MEDIA_IMAGES) else add(Manifest.permission.READ_EXTERNAL_STORAGE)
	if (Build.VERSION.SDK_INT >= 34) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
	add(Manifest.permission.ACCESS_MEDIA_LOCATION)
	if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
}.toTypedArray()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickerScreen(vm: AppViewModel, albumId: String?) {
	val context = LocalContext.current
	val haptics = LocalHapticFeedback.current
	fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
	fun fullAccess() = if (Build.VERSION.SDK_INT >= 33) granted(Manifest.permission.READ_MEDIA_IMAGES) else granted(Manifest.permission.READ_EXTERNAL_STORAGE)
	fun partialAccess() = Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
	var access by remember { mutableStateOf(fullAccess() || partialAccess()) }
	var locationAccess by remember { mutableStateOf(granted(Manifest.permission.ACCESS_MEDIA_LOCATION)) }
	var photos by remember { mutableStateOf<List<LocalPhoto>?>(null) }
	var reloadKey by remember { mutableStateOf(0) }
	val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
		access = fullAccess() || partialAccess(); locationAccess = granted(Manifest.permission.ACCESS_MEDIA_LOCATION); reloadKey++
	}
	LaunchedEffect(Unit) { if (!access || !locationAccess) launcher.launch(mediaPermissions()) }
	LaunchedEffect(access, reloadKey) { if (access) photos = LocalGallery.photos(context) }

	val album: Album? = albumId?.let(vm::album)
	// Files already in the album (same name and size) are marked and cannot be picked again.
	val already = remember(albumId, vm.photos[albumId ?: ""]) { vm.photos[albumId ?: ""]?.photos?.mapNotNull { it.uploadKey }?.toSet().orEmpty() }
	var bucket by remember { mutableStateOf<String?>(null) }
	var selected by remember { mutableStateOf(listOf<Long>()) }
	var dragBase by remember { mutableStateOf(listOf<Long>()) }
	var choosingAlbum by remember { mutableStateOf(false) }
	val visible = remember(photos, bucket) { photos.orEmpty().filter { bucket == null || it.bucket == bucket } }
	val rows = remember(visible) {
		val zone = ZoneId.systemDefault()
		var index = 0
		visible.groupBy { Instant.ofEpochMilli(it.takenAt).atZone(zone).toLocalDate() }.flatMap { (day, items) ->
			listOf<PickerRow>(PickerRow.Day(day.format(DAY_HEADER), items)) + items.map { PickerRow.Item(it, index++) }
		}
	}
	val byId = remember(photos) { photos.orEmpty().associateBy { it.id } }
	val grid = rememberLazyGridState()
	fun pickable(photo: LocalPhoto) = photo.uploadKey !in already
	fun toggle(photo: LocalPhoto) {
		if (!pickable(photo)) return
		selected = if (photo.id in selected) selected - photo.id else selected + photo.id
	}
	fun send(target: Album) {
		vm.upload(target, selected.mapNotNull(byId::get))
		vm.back()
		if (albumId == null) vm.open(Screen.AlbumDetail(target.id))
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(if (selected.isEmpty()) "写真を選ぶ" else "${selected.size}点を選択", fontWeight = FontWeight.SemiBold) },
				navigationIcon = { IconButton(onClick = { vm.back() }) { Icon(Glyph.Close, "閉じる") } },
				actions = { if (selected.isNotEmpty()) TextButton(onClick = { selected = emptyList() }) { Text("選択を解除") } },
				colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
			)
		},
		bottomBar = {
			Surface(color = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 2.dp) {
				Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
					Column(Modifier.weight(1f)) {
						Text(album?.let { "追加先：${it.title}" } ?: "追加先は次に選びます", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
						Text(
							if (locationAccess) "撮影日時と位置情報を残して送ります" else "位置情報の権限がないため、位置は送られません",
							style = MaterialTheme.typography.bodySmall,
							color = if (locationAccess) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
						)
					}
					Button(onClick = { if (album != null) send(album) else choosingAlbum = true }, enabled = selected.isNotEmpty()) {
						Text(if (selected.isEmpty()) "追加" else "${selected.size}点を追加")
					}
				}
			}
		},
	) { padding ->
		Column(Modifier.fillMaxSize().padding(padding)) {
			if (!access) {
				Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
					Text("写真へのアクセスを許可してください", style = MaterialTheme.typography.titleMedium)
					Text("「すべて許可」にすると、端末の写真から選べます。位置情報（撮影場所）を残すには「写真の位置情報」の許可も必要です。", color = MaterialTheme.colorScheme.onSurfaceVariant)
					Button(onClick = { launcher.launch(mediaPermissions()) }) { Text("許可する") }
				}
				return@Column
			}
			if (!fullAccess() && partialAccess()) Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
				Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
					Text("許可した写真だけを表示しています", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
					TextButton(onClick = { launcher.launch(mediaPermissions()) }) { Text("ほかの写真も選ぶ") }
				}
			}
			val buckets = remember(photos) { photos.orEmpty().groupingBy { it.bucket }.eachCount().entries.sortedByDescending { it.value }.map { it.key } }
			Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				FilterChip(selected = bucket == null, onClick = { bucket = null }, label = { Text("すべて") })
				buckets.forEach { name -> FilterChip(selected = bucket == name, onClick = { bucket = if (bucket == name) null else name }, label = { Text(name) }) }
			}
			if (photos == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
			else LazyVerticalGrid(
				state = grid,
				columns = GridCells.Adaptive(92.dp),
				horizontalArrangement = Arrangement.spacedBy(2.dp),
				verticalArrangement = Arrangement.spacedBy(2.dp),
				contentPadding = PaddingValues(bottom = 24.dp),
				modifier = Modifier.fillMaxSize().dragToSelect(
					grid,
					keyAt = { key -> (key as? Long)?.let { id -> visible.indexOfFirst { it.id == id }.takeIf { it >= 0 } } },
					onStart = { index ->
						haptics.performHapticFeedback(HapticFeedbackType.LongPress)
						dragBase = selected
						visible[index].takeIf(::pickable)?.let { if (it.id !in selected) selected = selected + it.id }
					},
					onRange = { from, to ->
						val range = if (from <= to) from..to else to..from
						selected = dragBase + visible.slice(range).filter(::pickable).map { it.id }.filter { it !in dragBase }
					},
				),
			) {
				rows.forEach { row ->
					when (row) {
						is PickerRow.Day -> item(span = { GridItemSpan(maxLineSpan) }, key = "day-${row.label}") {
							val ids = row.photos.filter(::pickable).map { it.id }
							val all = ids.isNotEmpty() && selected.containsAll(ids)
							Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 12.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
								Text(row.label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
								if (ids.isNotEmpty()) TextButton(onClick = { selected = if (all) selected - ids.toSet() else selected + ids.filter { it !in selected } }) {
									Text(if (all) "解除" else "この日をすべて選択", fontSize = 13.sp)
								}
							}
						}
						is PickerRow.Item -> item(key = row.photo.id) {
							val photo = row.photo
							val order = selected.indexOf(photo.id)
							val added = !pickable(photo)
							Box(Modifier.aspectRatio(1f).clickable { toggle(photo) }) {
								LocalImage(photo.uri, Modifier.fillMaxSize().then(if (order >= 0) Modifier.padding(8.dp).clip(RoundedCornerShape(8.dp)) else Modifier))
								if (added) {
									Box(Modifier.fillMaxSize().background(Color(0xA6111213)))
									Flag("追加済み", Color(0xE6646970), Modifier.align(Alignment.BottomStart).padding(5.dp))
								} else SelectionMark(order >= 0, number = (order + 1).takeIf { it > 0 }, modifier = Modifier.align(Alignment.TopEnd).padding(6.dp))
							}
						}
					}
				}
			}
		}
	}

	if (choosingAlbum) AlbumChooser(
		albums = vm.albums,
		onDismiss = { choosingAlbum = false },
		onChoose = { target -> choosingAlbum = false; send(target) },
		onCreate = { title -> choosingAlbum = false; vm.createAlbum(title) { created -> send(created) } },
	)
}

@Composable
private fun AlbumChooser(albums: List<Album>, onDismiss: () -> Unit, onChoose: (Album) -> Unit, onCreate: (String) -> Unit) {
	var newTitle by remember { mutableStateOf("") }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("追加先のアルバム") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
				OutlinedTextField(newTitle, { newTitle = it }, label = { Text("新しいアルバムの名前") }, singleLine = true, modifier = Modifier.fillMaxWidth())
				TextButton(onClick = { onCreate(newTitle.trim()) }, enabled = newTitle.isNotBlank()) { Text("新しいアルバムを作って追加") }
				HorizontalDivider()
				LazyColumn(Modifier.height(280.dp)) {
					items(albums, key = { it.id }) { album ->
						Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onChoose(album) }.padding(vertical = 8.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
							RemoteImage(album.coverKey, 320, Modifier.height(44.dp).aspectRatio(1.5f).clip(RoundedCornerShape(6.dp)), source = album.coverSource)
							Column(Modifier.padding(start = 12.dp)) {
								Text(album.title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
								if (!album.isPublished) Text("下書き", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
							}
						}
					}
				}
			}
		},
		confirmButton = {},
		dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
	)
}
