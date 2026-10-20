package com.kanouk.photos.media

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import com.kanouk.photos.data.PhotoExif
import java.io.InputStream
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

private val EXIF_DATE = DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss")

/**
 * The original file, GPS included. Android removes the location from photos it
 * hands out unless the app holds ACCESS_MEDIA_LOCATION and asks for the original.
 */
fun Context.openOriginal(uri: Uri): InputStream? {
	val original = runCatching { MediaStore.setRequireOriginal(uri) }.getOrDefault(uri)
	return runCatching { contentResolver.openInputStream(original) }.getOrNull()
		?: contentResolver.openInputStream(uri)
}

/** Capture time (UTC ISO, like the web organizer) and location from the original's EXIF. */
fun Context.readExif(uri: Uri): PhotoExif {
	val exif = runCatching { openOriginal(uri)?.use { ExifInterface(it) } }.getOrNull()
		?: return PhotoExif(null, null, null, null)
	val captured = (exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: exif.getAttribute(ExifInterface.TAG_DATETIME))?.let { text ->
		runCatching {
			val local = LocalDateTime.parse(text.trim(), EXIF_DATE)
			val offset = exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL) ?: exif.getAttribute(ExifInterface.TAG_OFFSET_TIME)
			val zoned = if (offset != null && Regex("^[+-]\\d{2}:\\d{2}$").matches(offset)) OffsetDateTime.of(local, ZoneOffset.of(offset))
			else local.atZone(ZoneId.systemDefault()).toOffsetDateTime()
			zoned.toInstant().toString()
		}.getOrNull()
	}
	val latLong = exif.latLong
	// A GPS block with 0/0 is what Android leaves when it strips the location.
	val hasGpsTags = exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE) != null
	val usable = latLong != null && !(latLong[0] == 0.0 && latLong[1] == 0.0)
	val altitude = exif.getAltitude(Double.NaN).takeIf { usable && !it.isNaN() }
	return PhotoExif(
		capturedAt = captured,
		latitude = if (usable) latLong[0] else null,
		longitude = if (usable) latLong[1] else null,
		altitude = altitude,
		locationErased = hasGpsTags && !usable,
	)
}
