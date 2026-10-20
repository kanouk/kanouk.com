plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.plugin.compose")
	id("org.jetbrains.kotlin.plugin.serialization")
}

android {
	namespace = "com.kanouk.photos"
	compileSdk = 37

	defaultConfig {
		applicationId = "com.kanouk.photos"
		minSdk = 30
		targetSdk = 36
		versionCode = 1
		versionName = "0.1.0"
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			// Installed by USB for the owner only; the debug key is enough.
			signingConfig = signingConfigs.getByName("debug")
		}
	}

	buildFeatures {
		compose = true
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
}

dependencies {
	val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
	implementation(composeBom)
	implementation("androidx.compose.ui:ui")
	implementation("androidx.compose.foundation:foundation")
	implementation("androidx.compose.material3:material3")
	implementation("androidx.activity:activity-compose:1.13.0")
	implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
	implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
	implementation("androidx.core:core-ktx:1.19.1")
	implementation("androidx.work:work-runtime-ktx:2.12.0")
	implementation("androidx.exifinterface:exifinterface:1.4.2")
	implementation("io.coil-kt.coil3:coil-compose:3.6.3")
	implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")
	implementation("io.coil-kt.coil3:coil-svg:3.6.3")
	implementation("com.squareup.okhttp3:okhttp:5.5.0")
	implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
