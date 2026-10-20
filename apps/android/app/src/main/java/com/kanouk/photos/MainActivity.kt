package com.kanouk.photos

import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import com.kanouk.photos.ui.AlbumScreen
import com.kanouk.photos.ui.AlbumsScreen
import com.kanouk.photos.ui.AppViewModel
import com.kanouk.photos.ui.Glyph
import com.kanouk.photos.ui.KanologTheme
import com.kanouk.photos.ui.LibraryScreen
import com.kanouk.photos.ui.LoginScreen
import com.kanouk.photos.ui.PickerScreen
import com.kanouk.photos.ui.Screen
import com.kanouk.photos.ui.SearchScreen
import com.kanouk.photos.ui.ViewerScreen

class MainActivity : ComponentActivity() {
	private val vm: AppViewModel by viewModels()

	override fun onResume() {
		super.onResume()
		vm.checkLoginNow()
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		// The app is always dark: light status and navigation bar icons.
		enableEdgeToEdge(SystemBarStyle.dark(AndroidColor.TRANSPARENT), SystemBarStyle.dark(AndroidColor.TRANSPARENT))
		setContent {
			KanologTheme {
				val snackbar = remember { SnackbarHostState() }
				LaunchedEffect(vm.notice) {
					vm.notice?.let { snackbar.showSnackbar(it); vm.notice = null }
				}
				BackHandler(enabled = vm.stack.size > 1) { vm.back() }
				// Back from Library or Search goes to the galleries before leaving the app.
				BackHandler(enabled = vm.stack.size == 1 && vm.screen is Screen.Tab && vm.screen != Screen.Albums) { vm.selectTab(Screen.Albums) }
				val tab = vm.screen as? Screen.Tab
				Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
					// The tab bar takes the navigation bar inset; screens above it must not pad for it again.
					Box(Modifier.weight(1f).then(if (tab != null) Modifier.consumeWindowInsets(WindowInsets.navigationBars) else Modifier)) {
						AnimatedContent(vm.screen, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "screen") { screen ->
							when (screen) {
								Screen.Login -> LoginScreen(vm)
								Screen.Albums -> AlbumsScreen(vm, snackbar)
								Screen.Library -> LibraryScreen(vm, snackbar)
								Screen.Search -> SearchScreen(vm, snackbar)
								is Screen.AlbumDetail -> AlbumScreen(vm, screen.albumId, snackbar)
								is Screen.Picker -> PickerScreen(vm, screen.albumId)
								is Screen.Viewer -> ViewerScreen(vm, screen.albumId, screen.photoId)
							}
						}
					}
					if (tab != null) TabBar(tab) { vm.selectTab(it) }
				}
			}
		}
	}
}

@Composable
private fun TabBar(current: Screen.Tab, onSelect: (Screen.Tab) -> Unit) {
	NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
		val colors = NavigationBarItemDefaults.colors(
			selectedIconColor = MaterialTheme.colorScheme.primary,
			selectedTextColor = MaterialTheme.colorScheme.primary,
			indicatorColor = Color.Transparent,
			unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
			unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
		)
		val tabs: List<Triple<Screen.Tab, ImageVector, String>> = listOf(
			Triple(Screen.Albums, Glyph.Galleries, "ギャラリー"),
			Triple(Screen.Library, Glyph.Library, "ライブラリ"),
			Triple(Screen.Search, Glyph.Search, "検索"),
		)
		for ((tab, icon, label) in tabs) NavigationBarItem(
			selected = tab == current,
			onClick = { onSelect(tab) },
			icon = { Icon(icon, null) },
			label = { Text(label) },
			colors = colors,
		)
	}
}
