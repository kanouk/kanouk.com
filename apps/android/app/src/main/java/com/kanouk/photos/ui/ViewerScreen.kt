package com.kanouk.photos.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.kanouk.photos.data.Photo
import com.kanouk.photos.data.siteDateTime

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewerScreen(vm: AppViewModel, albumId: String, photoId: String) {
	val context = LocalContext.current
	val album = vm.album(albumId) ?: return
	val photos = vm.photos[albumId]?.photos.orEmpty()
	if (photos.isEmpty()) return
	val start = photos.indexOfFirst { it.id == photoId }.coerceAtLeast(0)
	val pager = rememberPagerState(initialPage = start) { photos.size }
	var chrome by remember { mutableStateOf(true) }
	var editing by remember { mutableStateOf(false) }
	var confirmDelete by remember { mutableStateOf(false) }
	val photo = photos.getOrNull(pager.currentPage) ?: return
	LaunchedEffect(pager.currentPage) { if (pager.currentPage >= photos.size - 6) vm.loadMore(albumId) }

	Box(Modifier.fillMaxSize().background(Color(0xFF0D0D0E))) {
		HorizontalPager(pager, key = { photos[it].id }, beyondViewportPageCount = 1, modifier = Modifier.fillMaxSize()) { page ->
			ZoomableImage(photos[page], onTap = { chrome = !chrome })
		}
		AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
			Row(
				Modifier.fillMaxWidth().background(Color(0x99000000)).statusBarsPadding().padding(horizontal = 4.dp, vertical = 2.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				IconButton(onClick = { vm.back() }) { Icon(Glyph.Close, "閉じる", tint = Color.White) }
				Text("${pager.currentPage + 1} / ${vm.photos[albumId]?.total ?: photos.size}", color = Color(0xCCFFFFFF), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
				photo.stateLabel?.let { Flag(it, stateTone(photo), Modifier.padding(end = 12.dp)) }
			}
		}
		AnimatedVisibility(chrome, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomCenter)) {
			Column(Modifier.fillMaxWidth().background(Color(0xB3000000)).navigationBarsPadding().padding(top = 12.dp)) {
				Column(Modifier.padding(horizontal = 18.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
					Text(photo.displayTitle ?: "タイトル未設定", color = if (photo.displayTitle != null) Color.White else Color(0x99FFFFFF), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
					val meta = listOfNotNull(siteDateTime(photo.capturedAt), if (photo.hasLocation) "位置情報あり" else "位置情報なし").joinToString(" · ")
					Text(meta, color = Color(0x99FFFFFF), style = MaterialTheme.typography.bodySmall)
				}
				Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
					ActionButton(Glyph.Edit, "編集", tint = Color.White, enabled = vm.working == null) { editing = true }
					ActionButton(if (photo.hidden) Glyph.Show else Glyph.Hide, if (photo.hidden) "再び公開" else "非公開", tint = Color.White, enabled = vm.working == null) {
						vm.setHidden(album, listOf(photo), !photo.hidden)
					}
					ActionButton(Glyph.Star, "表紙にする", tint = Color.White, enabled = vm.working == null && album.coverKey != photo.imageKey) { vm.makeCover(album, photo) }
					ActionButton(Glyph.Pin, "地図", tint = Color.White, enabled = photo.hasLocation) {
						context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:${photo.latitude},${photo.longitude}?q=${photo.latitude},${photo.longitude}")))
					}
					ActionButton(Glyph.Trash, "削除", tint = Color(0xFFFF8A80), enabled = vm.working == null) { confirmDelete = true }
				}
				vm.working?.let { Text(it, color = Color(0xCCFFFFFF), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 18.dp, bottom = 6.dp)) }
			}
		}
	}

	if (editing) {
		var title by remember(photo.id) { mutableStateOf(photo.displayTitle ?: "") }
		var caption by remember(photo.id) { mutableStateOf(photo.caption.takeUnless { it == photo.title || it == photo.displayTitle } ?: "") }
		ModalBottomSheet(onDismissRequest = { editing = false }) {
			Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
				Text("写真の情報", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
				OutlinedTextField(title, { title = it }, label = { Text("タイトル") }, singleLine = true, modifier = Modifier.fillMaxWidth())
				OutlinedTextField(caption, { caption = it }, label = { Text("キャプション") }, minLines = 3, modifier = Modifier.fillMaxWidth())
				Text("保存すると下書きになり、アルバムの「公開」でサイトに出ます。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
					TextButton(onClick = { editing = false }) { Text("キャンセル") }
					Spacer(Modifier.width(8.dp))
					Button(onClick = { vm.editPhoto(album, photo, title, caption) { editing = false } }, enabled = vm.working == null) { Text(vm.working ?: "保存") }
				}
			}
		}
	}
	if (confirmDelete) ConfirmDialog(
		title = "この写真を削除しますか？", text = "管理画面のゴミ箱から戻せます。", confirm = "削除",
		onDismiss = { confirmDelete = false },
		onConfirm = { confirmDelete = false; vm.trash(album, listOf(photo)) { if (photos.size <= 1) vm.back() } },
	)
}

/** Pinch (around the fingers) or double-tap (where tapped) to zoom; drag to look around while zoomed. */
@Composable
private fun ZoomableImage(photo: Photo, onTap: () -> Unit) {
	var scale by remember { mutableFloatStateOf(1f) }
	var offset by remember { mutableStateOf(Offset.Zero) }
	var size by remember { mutableStateOf(IntSize.Zero) }
	fun clampOffset(value: Offset, zoom: Float): Offset {
		val maxX = size.width * (zoom - 1) / 2
		val maxY = size.height * (zoom - 1) / 2
		return Offset(value.x.coerceIn(-maxX, maxX), value.y.coerceIn(-maxY, maxY))
	}
	fun zoomAt(point: Offset, target: Float, pan: Offset = Offset.Zero) {
		val next = target.coerceIn(1f, 5f)
		val center = Offset(size.width / 2f, size.height / 2f)
		val factor = next / scale
		offset = if (next <= 1f) Offset.Zero else clampOffset((point - center) * (1 - factor) + offset * factor + pan, next)
		scale = next
	}
	val transform = rememberTransformableState { centroid, zoom, pan, _ -> zoomAt(centroid, scale * zoom, if (scale > 1f) pan else Offset.Zero) }
	Box(
		Modifier.fillMaxSize()
			.onSizeChanged { size = it }
			.pointerInput(photo.id) {
				detectTapGestures(
					onTap = { onTap() },
					onDoubleTap = { point -> if (scale > 1f) zoomAt(point, 1f) else zoomAt(point, 2.5f) },
				)
			}
			.transformable(transform, canPan = { scale > 1f }),
		contentAlignment = Alignment.Center,
	) {
		RemoteImage(
			photo.imageKey, 1600,
			Modifier.fillMaxSize().graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
			contentScale = ContentScale.Fit,
			source = photo.imageSource,
			placeholder = Color.Transparent,
		)
	}
}
