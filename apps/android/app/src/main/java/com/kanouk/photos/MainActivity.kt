package com.kanouk.photos

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import com.kanouk.photos.ui.AlbumScreen
import com.kanouk.photos.ui.AlbumsScreen
import com.kanouk.photos.ui.AppViewModel
import com.kanouk.photos.ui.KanologTheme
import com.kanouk.photos.ui.LoginScreen
import com.kanouk.photos.ui.PickerScreen
import com.kanouk.photos.ui.Screen
import com.kanouk.photos.ui.ViewerScreen

class MainActivity : ComponentActivity() {
	private val vm: AppViewModel by viewModels()

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		enableEdgeToEdge()
		setContent {
			KanologTheme {
				val snackbar = remember { SnackbarHostState() }
				LaunchedEffect(vm.notice) {
					vm.notice?.let { snackbar.showSnackbar(it); vm.notice = null }
				}
				BackHandler(enabled = vm.stack.size > 1) { vm.back() }
				AnimatedContent(vm.screen, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "screen") { screen ->
					when (screen) {
						Screen.Login -> LoginScreen(vm)
						Screen.Albums -> AlbumsScreen(vm, snackbar)
						is Screen.AlbumDetail -> AlbumScreen(vm, screen.albumId, snackbar)
						is Screen.Picker -> PickerScreen(vm, screen.albumId)
						is Screen.Viewer -> ViewerScreen(vm, screen.albumId, screen.photoId)
					}
				}
			}
		}
	}
}
