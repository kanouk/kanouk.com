package com.kanouk.photos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import kotlinx.coroutines.coroutineScope
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import com.kanouk.photos.AppGraph
import com.kanouk.photos.data.previewPath
import com.kanouk.photos.upload.UploadBatch
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** A stored photo, resized by the site (the same preview route as the public pages). */
@Composable
fun RemoteImage(key: String?, width: Int, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop, source: String? = null, placeholder: Color = MaterialTheme.colorScheme.surfaceVariant) {
	val base = AppGraph.session.baseUrl
	val url = when {
		key != null -> base + previewPath(key, width)
		source == null -> null
		source.startsWith("http") -> source
		else -> base + source
	}
	Box(modifier.background(placeholder)) {
		if (url != null) AsyncImage(
			model = url,
			contentDescription = null,
			contentScale = contentScale,
			modifier = Modifier.fillMaxSize(),
		)
	}
}

@Composable
fun LocalImage(uri: android.net.Uri, modifier: Modifier = Modifier) {
	val context = LocalContext.current
	AsyncImage(
		model = remember(uri) { ImageRequest.Builder(context).data(uri).size(360).build() },
		contentDescription = null,
		contentScale = ContentScale.Crop,
		modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant),
	)
}

/** Draft (new) photos get a quiet label; changes waiting to be published stand out. */
fun stateTone(photo: com.kanouk.photos.data.Photo): Color = when {
	photo.hidden -> Color(0xE6646970)
	!photo.isPublished -> Color(0x8C000000)
	else -> Color(0xE6B26A00)
}

/** A small label on a photo: 下書き, 変更あり, 非公開, 表紙. */
@Composable
fun Flag(text: String, tone: Color = Color(0xE61D2327), modifier: Modifier = Modifier) {
	Text(
		text, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
		modifier = modifier.background(tone, RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
	)
}

/** Selection circle on a tile: a white ring when not chosen, filled (with the order number) when chosen. */
@Composable
fun SelectionMark(selected: Boolean, number: Int? = null, modifier: Modifier = Modifier) {
	Box(
		modifier
			.size(24.dp)
			.clip(CircleShape)
			.background(if (selected) MaterialTheme.colorScheme.primary else Color(0x33000000))
			.border(2.dp, Color.White, CircleShape),
		contentAlignment = Alignment.Center,
	) {
		if (selected) {
			if (number != null) Text("$number", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
			else Icon(Glyph.Check, null, tint = Color.White, modifier = Modifier.size(15.dp))
		}
	}
}

@Composable
fun ActionButton(icon: ImageVector, label: String, enabled: Boolean = true, tint: Color = MaterialTheme.colorScheme.onSurface, onClick: () -> Unit) {
	TextButton(onClick = onClick, enabled = enabled) {
		Column(horizontalAlignment = Alignment.CenterHorizontally) {
			Icon(icon, null, tint = if (enabled) tint else tint.copy(alpha = 0.38f), modifier = Modifier.size(22.dp))
			Text(label, fontSize = 11.sp, color = if (enabled) tint else tint.copy(alpha = 0.38f))
		}
	}
}

@Composable
fun UploadCard(batch: UploadBatch, onRetry: () -> Unit, onDismiss: () -> Unit, onOpen: (() -> Unit)? = null) {
	Surface(
		color = MaterialTheme.colorScheme.surfaceContainer,
		shape = RoundedCornerShape(14.dp),
		onClick = onOpen ?: {},
		modifier = Modifier.fillMaxWidth(),
	) {
		Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Icon(Glyph.Upload, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
				Spacer(Modifier.width(8.dp))
				Text(
					if (batch.running) "「${batch.albumTitle}」に追加中" else "「${batch.albumTitle}」に${batch.done}点を追加",
					style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
				)
				Text("${batch.settled} / ${batch.items.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
				if (!batch.running) IconButton(onClick = onDismiss, modifier = Modifier.size(32.dp)) { Icon(Glyph.Close, "閉じる", modifier = Modifier.size(16.dp)) }
			}
			if (batch.running) LinearProgressIndicator(
				progress = { if (batch.items.isEmpty()) 0f else batch.settled / batch.items.size.toFloat() },
				modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(50)),
			)
			val notes = buildList {
				if (batch.duplicates > 0) add("アルバムにある${batch.duplicates}点は省略")
				if (batch.failed > 0) add("${batch.failed}点が失敗")
				if (batch.locationErased > 0) add("${batch.locationErased}点は位置情報が端末で消されていました")
				batch.message?.let(::add)
				if (!batch.running && batch.failed == 0) add("「公開」でサイトに出ます")
			}
			if (notes.isNotEmpty()) Text(notes.joinToString("・"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
			if (!batch.running && batch.failed > 0) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
				TextButton(onClick = onRetry) { Text("失敗分を再試行") }
			}
		}
	}
}

@Composable
fun TextInputDialog(
	title: String,
	label: String,
	initial: String = "",
	confirm: String,
	secondLabel: String? = null,
	secondInitial: String = "",
	onDismiss: () -> Unit,
	onConfirm: (String, String) -> Unit,
) {
	var value by remember { mutableStateOf(initial) }
	var second by remember { mutableStateOf(secondInitial) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
				OutlinedTextField(value, { value = it }, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth())
				if (secondLabel != null) OutlinedTextField(second, { second = it }, label = { Text(secondLabel) }, minLines = 2, modifier = Modifier.fillMaxWidth())
			}
		},
		confirmButton = { TextButton(onClick = { onConfirm(value, second) }, enabled = value.isNotBlank()) { Text(confirm) } },
		dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
	)
}

@Composable
fun ConfirmDialog(title: String, text: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(title) },
		text = { Text(text) },
		confirmButton = { TextButton(onClick = onConfirm) { Text(confirm, color = MaterialTheme.colorScheme.error) } },
		dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
	)
}

/**
 * Long-press a tile, then drag across others to select a run of them (as in the
 * phone's own gallery). The gesture is read before the grid's own scrolling sees
 * it; the list scrolls by itself when the finger nears the top or bottom edge.
 */
fun Modifier.dragToSelect(
	state: LazyGridState,
	keyAt: (Any?) -> Int?,
	onStart: (Int) -> Unit,
	onRange: (from: Int, to: Int) -> Unit,
	/** Points where another long-press gesture (the reorder handle) takes over. */
	skipAt: (Offset) -> Boolean = { false },
): Modifier = pointerInput(state) {
	coroutineScope {
		val scope = this
		fun indexAt(point: Offset): Int? = state.layoutInfo.visibleItemsInfo.firstOrNull { item ->
			point.x >= item.offset.x && point.x < item.offset.x + item.size.width &&
				point.y >= item.offset.y && point.y < item.offset.y + item.size.height
		}?.let { keyAt(it.key) }
		awaitEachGesture {
			val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
			if (skipAt(down.position) || !awaitLongPressStill(down)) return@awaitEachGesture
			val start = indexAt(down.position) ?: return@awaitEachGesture
			onStart(start)
			var point = down.position
			var speed = 0f
			val edge = 80.dp.toPx()
			val autoscroll = scope.launch {
				while (isActive) {
					if (speed != 0f) {
						state.scrollBy(speed)
						indexAt(point)?.let { onRange(start, it) }
					}
					delay(16)
				}
			}
			try {
				while (true) {
					val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
					// Keep the grid from scrolling and the tile from treating the release as a tap.
					change.consume()
					if (!change.pressed) break
					point = change.position
					indexAt(point)?.let { onRange(start, it) }
					speed = when {
						point.y < edge -> -(edge - point.y) / 3
						point.y > size.height - edge -> (point.y - (size.height - edge)) / 3
						else -> 0f
					}
				}
			} finally {
				autoscroll.cancel()
			}
		}
	}
}

/**
 * Wait out the long-press time on the Initial pass; moving or lifting first leaves
 * the gesture to scrolling and taps. True when the finger stayed down and still.
 */
suspend fun AwaitPointerEventScope.awaitLongPressStill(down: PointerInputChange): Boolean {
	val interrupted = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
		while (true) {
			val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull true
			if (!change.pressed || (change.position - down.position).getDistance() > viewConfiguration.touchSlop) return@withTimeoutOrNull true
		}
		@Suppress("UNREACHABLE_CODE") true
	}
	return interrupted == null
}
