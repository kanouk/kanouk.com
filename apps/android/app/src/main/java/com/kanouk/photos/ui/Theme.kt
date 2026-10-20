package com.kanouk.photos.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The photo site's palette: warm paper, near-black ink, one indigo accent.
private val Light = lightColorScheme(
	primary = Color(0xFF3B4E8C),
	onPrimary = Color.White,
	primaryContainer = Color(0xFFE4E8F6),
	onPrimaryContainer = Color(0xFF1D2A55),
	secondaryContainer = Color(0xFFEDEBE5),
	onSecondaryContainer = Color(0xFF1D2327),
	background = Color(0xFFFCFBF8),
	onBackground = Color(0xFF1D2327),
	surface = Color(0xFFFCFBF8),
	onSurface = Color(0xFF1D2327),
	surfaceVariant = Color(0xFFF1EFEA),
	onSurfaceVariant = Color(0xFF646970),
	surfaceContainer = Color(0xFFF4F2EE),
	surfaceContainerHigh = Color(0xFFEFEDE8),
	surfaceContainerLow = Color(0xFFF8F7F3),
	outline = Color(0xFFD5D2CA),
	outlineVariant = Color(0xFFE6E3DC),
	error = Color(0xFFB3261E),
)

private val Dark = darkColorScheme(
	primary = Color(0xFFB9C4F0),
	onPrimary = Color(0xFF1D2A55),
	primaryContainer = Color(0xFF2E3D6E),
	onPrimaryContainer = Color(0xFFE4E8F6),
	background = Color(0xFF111213),
	surface = Color(0xFF111213),
	surfaceVariant = Color(0xFF26282A),
	surfaceContainer = Color(0xFF1B1C1E),
	surfaceContainerHigh = Color(0xFF232527),
	surfaceContainerLow = Color(0xFF17181A),
	onSurfaceVariant = Color(0xFFA7AAAD),
	outline = Color(0xFF3A3D40),
	outlineVariant = Color(0xFF2C2F32),
)

@Composable
fun KanologTheme(content: @Composable () -> Unit) {
	MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
