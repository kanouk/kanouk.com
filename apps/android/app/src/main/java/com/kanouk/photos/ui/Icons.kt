package com.kanouk.photos.ui

import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** Line icons drawn from SVG paths (the same set as the web organizer), tinted by Icon. */
object Glyph {
	private fun icon(name: String, vararg paths: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
		for (d in paths) addPath(
			pathData = PathParser().parsePathString(d).toNodes(),
			stroke = SolidColor(Color.Black),
			strokeLineWidth = 1.8f,
			strokeLineCap = StrokeCap.Round,
			strokeLineJoin = StrokeJoin.Round,
		)
	}.build()

	val Back = icon("back", "M15 18l-6-6 6-6")
	val Close = icon("close", "M18 6L6 18M6 6l12 12")
	val Plus = icon("plus", "M12 5v14M5 12h14")
	val Upload = icon("upload", "M12 16V4M7 9l5-5 5 5M5 20h14")
	val More = icon("more", "M12 5.5v.01M12 12v.01M12 18.5v.01")
	val Check = icon("check", "M5 12.5l4.5 4.5L19 7.5")
	val Star = icon("star", "M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z")
	val Hide = icon("hide", "M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 8.5 4.3 9.5 7a12 12 0 0 1-2.6 3.8M6.6 6.6A12 12 0 0 0 2.5 12c1 2.7 4.5 7 9.5 7a9.6 9.6 0 0 0 4.4-1.1")
	val Show = icon("show", "M2.5 12c1-2.7 4.5-7 9.5-7s8.5 4.3 9.5 7c-1 2.7-4.5 7-9.5 7s-8.5-4.3-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z")
	val Trash = icon("trash", "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3")
	val Edit = icon("edit", "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4")
	val Pin = icon("pin", "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z")
	val Globe = icon("globe", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z")
	val Image = icon("image", "M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01")
	val Album = icon("album", "M4 7h16v12H4zM7 4h10M9 13l2 2 4-4")
	val Galleries = icon("galleries", "M4 8h13v12H4zM7 5h13v12M4 16l4-4 3 3 2-2 4 4")
	val Library = icon("library", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z")
	val Search = icon("search", "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4")
	val Handle = icon("handle", "M5 8h14M5 12h14M5 16h14")
	val Sort = icon("sort", "M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3")
	val Select = icon("select", "M4 4h16v16H4zM8 12l3 3 5-6")
	val Ellipsis = icon("ellipsis", "M6 12h.01M12 12h.01M18 12h.01")
}
