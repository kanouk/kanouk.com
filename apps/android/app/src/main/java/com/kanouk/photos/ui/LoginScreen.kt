package com.kanouk.photos.ui

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.toClipEntry
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(vm: AppViewModel) {
	val context = LocalContext.current
	val clipboard = LocalClipboard.current
	val scope = androidx.compose.runtime.rememberCoroutineScope()
	var server by remember { mutableStateOf(vm.session.baseUrl) }
	var showServer by remember { mutableStateOf(false) }
	Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding().padding(28.dp)) {
		Column(Modifier.align(Alignment.Center).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
			Box(Modifier.size(72.dp).background(Color(0xFF2B3A67), RoundedCornerShape(20.dp)), contentAlignment = Alignment.Center) {
				Icon(Glyph.Image, null, tint = Color.White, modifier = Modifier.size(34.dp))
			}
			Text("カノログ写真", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
			when (val state = vm.login) {
				is LoginState.Waiting -> {
					Text("ブラウザで、次のコードを承認してください。管理画面にログインしているブラウザで開きます。", textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
					Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(16.dp)) {
						Text(state.code.userCode, fontFamily = FontFamily.Monospace, fontSize = 32.sp, letterSpacing = 4.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 28.dp, vertical = 18.dp))
					}
					Button(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(state.code.verificationUri))) }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
						Text("ブラウザで承認する")
					}
					OutlinedButton(onClick = { scope.launch { clipboard.setClipEntry(ClipData.newPlainText("code", state.code.userCode).toClipEntry()) } }, modifier = Modifier.fillMaxWidth()) {
						Text("コードをコピー")
					}
					Row(verticalAlignment = Alignment.CenterVertically) {
						CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
						Spacer(Modifier.width(10.dp))
						Text("承認を待っています…", color = MaterialTheme.colorScheme.onSurfaceVariant)
					}
					TextButton(onClick = vm::cancelLogin) { Text("やめる") }
				}
				else -> {
					Text("アルバムの作成、写真のまとめての追加、編集と公開をこのスマホから。撮影日時と位置情報はそのまま送ります。", textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
					if (state is LoginState.Failed) Text(state.message, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
					Button(onClick = { vm.startLogin(server) }, enabled = state != LoginState.Starting, modifier = Modifier.fillMaxWidth().height(52.dp)) {
						Text(if (state == LoginState.Starting) "準備しています…" else "ログイン")
					}
					if (showServer) OutlinedTextField(server, { server = it }, label = { Text("接続先") }, singleLine = true, modifier = Modifier.fillMaxWidth())
					TextButton(onClick = { showServer = !showServer }) { Text(if (showServer) "接続先を閉じる" else "接続先: ${server.removePrefix("https://")}", color = MaterialTheme.colorScheme.onSurfaceVariant) }
				}
			}
		}
	}
}
