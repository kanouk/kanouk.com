package com.kanouk.photos.media

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import com.kanouk.photos.data.PhotoExif
import java.io.File
import java.io.InputStream
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

private val EXIF_DATE = DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss")
private val STRIPPABLE_TYPES = setOf("image/jpeg", "image/png", "image/webp")
private val GPS_TAGS = listOf(
	ExifInterface.TAG_GPS_VERSION_ID, ExifInterface.TAG_GPS_LATITUDE_REF, ExifInterface.TAG_GPS_LATITUDE,
	ExifInterface.TAG_GPS_LONGITUDE_REF, ExifInterface.TAG_GPS_LONGITUDE, ExifInterface.TAG_GPS_ALTITUDE_REF,
	ExifInterface.TAG_GPS_ALTITUDE, ExifInterface.TAG_GPS_TIMESTAMP, ExifInterface.TAG_GPS_SATELLITES,
	ExifInterface.TAG_GPS_STATUS, ExifInterface.TAG_GPS_MEASURE_MODE, ExifInterface.TAG_GPS_DOP,
	ExifInterface.TAG_GPS_SPEED_REF, ExifInterface.TAG_GPS_SPEED, ExifInterface.TAG_GPS_TRACK_REF,
	ExifInterface.TAG_GPS_TRACK, ExifInterface.TAG_GPS_IMG_DIRECTION_REF, ExifInterface.TAG_GPS_IMG_DIRECTION,
	ExifInterface.TAG_GPS_MAP_DATUM, ExifInterface.TAG_GPS_DEST_LATITUDE_REF, ExifInterface.TAG_GPS_DEST_LATITUDE,
	ExifInterface.TAG_GPS_DEST_LONGITUDE_REF, ExifInterface.TAG_GPS_DEST_LONGITUDE, ExifInterface.TAG_GPS_DEST_BEARING_REF,
	ExifInterface.TAG_GPS_DEST_BEARING, ExifInterface.TAG_GPS_DEST_DISTANCE_REF, ExifInterface.TAG_GPS_DEST_DISTANCE,
	ExifInterface.TAG_GPS_PROCESSING_METHOD, ExifInterface.TAG_GPS_AREA_INFORMATION, ExifInterface.TAG_GPS_DATESTAMP,
	ExifInterface.TAG_GPS_DIFFERENTIAL, ExifInterface.TAG_GPS_H_POSITIONING_ERROR,
)
// Places a location can sit outside the EXIF GPS block: XMP geotags and a motion photo's video.
private val OTHER_LOCATION = Regex("GPSLatitude|GPSLongitude|GPSAltitude|geo:lat|geo:long|exif:GPS|\\u00A9xyz")

/** Whether the file carries a location that [removeLocation] removes or refuses. */
private fun hasOtherLocation(file: File) = OTHER_LOCATION.containsMatchIn(String(file.readBytes(), Charsets.ISO_8859_1))

/**
 * Removes the EXIF GPS block from [file] in place, without re-encoding the image: capture time,
 * gain map and motion photo video stay. Returns whether anything was removed; throws when a
 * location would remain, so a photo meant to be location-free is never sent with one.
 */
fun removeLocation(file: File, mimeType: String): Boolean {
	val exif = if (mimeType in STRIPPABLE_TYPES) ExifInterface(file) else null
	val hadGps = exif?.let { current -> GPS_TAGS.any { current.getAttribute(it) != null } } ?: false
	if (exif != null && hadGps) {
		GPS_TAGS.forEach { exif.setAttribute(it, null) }
		exif.saveAttributes()
	}
	val remains = exif == null || ExifInterface(file).let { saved -> GPS_TAGS.any { saved.getAttribute(it) != null } } || hasOtherLocation(file)
	if (remains) error(if (exif == null) "この形式の写真は位置情報を消せません" else "位置情報を消せませんでした")
	return hadGps
}

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
