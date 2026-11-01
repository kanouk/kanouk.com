package com.kanouk.photos.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.kanouk.photos.data.CoverCrop
import com.kanouk.photos.data.Photo
import kotlin.math.abs
import kotlin.math.max

/** Pinch and drag a photo inside the square of the site's album list; it is saved as a [CoverCrop]. */
@Composable
fun CoverCropDialog(photo: Photo, initial: CoverCrop?, onDismiss: () -> Unit, onDone: (CoverCrop) -> Unit) {
	var crop by remember(photo.id) { mutableStateOf(initial ?: CoverCrop()) }
	var natural by remember(photo.id) { mutableStateOf<Size?>(null) }
	var frame by remember { mutableStateOf(IntSize.Zero) }

	// Dragging by one pixel moves x by 1 / (frame - shown image), the same geometry on both axes.
	fun moved(position: Float, panned: Float, frameSize: Int, shownSize: Float): Float {
		val travel = frameSize - shownSize
		return if (abs(travel) < 1f) position else (position + panned / travel).coerceIn(0f, 1f)
	}

	Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
		Column(Modifier.fillMaxSize().background(Color(0xFF0D0D0E)).statusBarsPadding().navigationBarsPadding()) {
			Text("表紙の範囲", color = Color.White, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(16.dp))
			Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
				RemoteImage(
					photo.imageKey, 1600,
					Modifier.fillMaxWidth().aspectRatio(1f)
						.onSizeChanged { frame = it }
						.pointerInput(photo.id) {
							detectTransformGestures { _, pan, zoomChange, _ ->
								val size = natural
								if (size != null && frame.width > 0 && size.width > 0f && size.height > 0f) {
									val zoom = (crop.zoom * zoomChange).coerceIn(1f, CoverCrop.MAX_ZOOM)
									val fit = max(frame.width / size.width, frame.height / size.height) * zoom
									crop = CoverCrop(
										moved(crop.x, pan.x, frame.width, size.width * fit),
										moved(crop.y, pan.y, frame.height, size.height * fit),
										zoom,
									)
								}
							}
						},
					source = photo.imageSource, crop = crop, onLoaded = { natural = it },
				)
			}
			Text(
				"ピンチで拡大縮小、ドラッグで位置を調整します。サイトのアルバム一覧の形です。アプリのほかの画面では、同じ位置を中心に形が変わります。",
				color = Color(0x99FFFFFF), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
			)
			Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
				TextButton(onClick = { crop = CoverCrop() }, enabled = !crop.isDefault) { Text("元に戻す") }
				Spacer(Modifier.weight(1f))
				TextButton(onClick = onDismiss) { Text("キャンセル") }
				Spacer(Modifier.width(8.dp))
				Button(onClick = { onDone(crop) }) { Text("完了") }
			}
		}
	}
}
