package com.kanouk.photos.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Always dark, as in SmugMug: photos stand out and the chrome recedes.
// The site's indigo accent, lightened to read on the dark ground.
private val Dark = darkColorScheme(
	primary = Color(0xFFB9C4F0),
	onPrimary = Color(0xFF1D2A55),
	primaryContainer = Color(0xFF2E3D6E),
	onPrimaryContainer = Color(0xFFE4E8F6),
	secondaryContainer = Color(0xFF2A2D33),
	onSecondaryContainer = Color(0xFFE6E7E9),
	background = Color(0xFF111213),
	onBackground = Color(0xFFECEDEE),
	surface = Color(0xFF111213),
	onSurface = Color(0xFFECEDEE),
	surfaceVariant = Color(0xFF26282A),
	onSurfaceVariant = Color(0xFFA7AAAD),
	surfaceContainer = Color(0xFF1B1C1E),
	surfaceContainerHigh = Color(0xFF232527),
	surfaceContainerHighest = Color(0xFF2B2D30),
	surfaceContainerLow = Color(0xFF17181A),
	outline = Color(0xFF3A3D40),
	outlineVariant = Color(0xFF2C2F32),
)

@Composable
fun KanologTheme(content: @Composable () -> Unit) {
	MaterialTheme(colorScheme = Dark, content = content)
}
