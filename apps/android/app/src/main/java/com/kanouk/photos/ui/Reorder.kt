package com.kanouk.photos.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.foundation.lazy.grid.LazyGridItemInfo
import androidx.compose.foundation.lazy.grid.LazyGridItemScope
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Long-press and drag a grid item to a new place; the others shift as it passes
 * (SmugMug's manual sort). Items are moved by key, so headers and other rows in
 * the same grid are left alone. The caller keeps the list and saves it in [onEnd].
 */
class GridReorder(
	val grid: LazyGridState,
	private val movable: (key: Any) -> Boolean,
	private val onStart: () -> Unit,
	private val onMove: (from: Any, to: Any) -> Unit,
	private val onEnd: () -> Unit,
) {
	var draggingKey by mutableStateOf<Any?>(null); private set
	/** Where the finger wants the dragged item's top-left, in the grid's own coordinates. */
	private var target by mutableStateOf(Offset.Zero)
	private var grab = Offset.Zero

	fun itemAt(point: Offset): LazyGridItemInfo? = grid.layoutInfo.visibleItemsInfo.firstOrNull { item ->
		point.x >= item.offset.x && point.x < item.offset.x + item.size.width &&
			point.y >= item.offset.y && point.y < item.offset.y + item.size.height
	}

	internal fun start(point: Offset): Boolean {
		val item = itemAt(point)?.takeIf { movable(it.key) } ?: return false
		draggingKey = item.key
		grab = point - Offset(item.offset.x.toFloat(), item.offset.y.toFloat())
		target = point - grab
		onStart()
		return true
	}

	internal fun drag(point: Offset) {
		val key = draggingKey ?: return
		target = point - grab
		val current = grid.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return
		val centre = target + Offset(current.size.width / 2f, current.size.height / 2f)
		val over = itemAt(centre)?.takeIf { it.key != key && movable(it.key) } ?: return
		// Keep the scroll position where it is; the grid would otherwise follow the moved first item.
		val first = grid.firstVisibleItemIndex
		val firstOffset = grid.firstVisibleItemScrollOffset
		onMove(key, over.key)
		grid.requestScrollToItem(first, firstOffset)
	}

	internal fun end() {
		if (draggingKey == null) return
		draggingKey = null
		onEnd()
	}

	/** How far the dragged item is drawn from where the grid placed it. */
	fun translation(key: Any): Offset {
		if (key != draggingKey) return Offset.Zero
		val current = grid.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return Offset.Zero
		return target - Offset(current.offset.x.toFloat(), current.offset.y.toFloat())
	}
}

/** Others slide into place; the dragged item follows the finger, drawn above the rest. */
fun LazyGridItemScope.reorderItem(reorder: GridReorder, key: Any): Modifier =
	Modifier.animateItem(placementSpec = if (reorder.draggingKey == key) null else spring(Spring.DampingRatioNoBouncy, Spring.StiffnessMediumLow, IntOffset.VisibilityThreshold))
		.zIndex(if (reorder.draggingKey == key) 1f else 0f).graphicsLayer {
		val offset = reorder.translation(key)
		translationX = offset.x
		translationY = offset.y
		if (reorder.draggingKey == key) { scaleX = 1.04f; scaleY = 1.04f; shadowElevation = 12f }
	}

/** The gesture for [GridReorder]: long-press where [startAt] allows, then drag; scrolls by itself near the edges. */
fun Modifier.reorderGesture(reorder: GridReorder, enabled: Boolean, startAt: (Offset) -> Boolean = { true }): Modifier =
	if (!enabled) this else pointerInput(reorder) {
		coroutineScope {
			val scope = this
			awaitEachGesture {
				val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
				if (!startAt(down.position) || !awaitLongPressStill(down)) return@awaitEachGesture
				if (!reorder.start(down.position)) return@awaitEachGesture
				var point = down.position
				var speed = 0f
				val edge = 80.dp.toPx()
				val autoscroll = scope.launch {
					while (isActive) {
						if (speed != 0f) {
							reorder.grid.scrollBy(speed)
							reorder.drag(point)
						}
						delay(16)
					}
				}
				try {
					while (true) {
						val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
						change.consume()
						if (!change.pressed) break
						point = change.position
						reorder.drag(point)
						speed = when {
							point.y < edge -> -(edge - point.y) / 3
							point.y > size.height - edge -> (point.y - (size.height - edge)) / 3
							else -> 0f
						}
					}
				} finally {
					autoscroll.cancel()
					reorder.end()
				}
			}
		}
	}
