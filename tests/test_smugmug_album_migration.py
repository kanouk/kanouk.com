from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT_ROOT = Path(__file__).parents[1] / "scripts/migration"
SPEC = importlib.util.spec_from_file_location(
    "migrate_smugmug_album", SCRIPT_ROOT / "migrate_smugmug_album.py"
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def asset(kind: str = "image") -> dict:
    return {
        "id": "kph_test",
        "position": 4,
        "kind": kind,
        "source": {
            "image_key": "source-key",
            "filename": "source.mp4" if kind == "video" else "source.jpg",
            "web_uri": "https://example.test/photo",
            "archived_md5": "abc",
        },
        "display": {"title": "Title", "caption": "Caption", "alt": "Alt"},
        "timestamps": {
            "captured_at": {"normalized": "2024-06-01T00:00:00Z"}
        },
    }


class SmugMugAlbumMigrationTests(unittest.TestCase):
    def test_image_payload_uses_original_as_image(self) -> None:
        payload = module.content_payload(
            asset(),
            album_id="album-id",
            source_media_id="source-media",
            poster_media_id=None,
            metadata={
                "captured_at": "2024-06-01T09:00:00+09:00",
                "location": {"latitude": 35.0, "longitude": 135.0},
            },
            source_sha256="sha",
        )
        self.assertEqual(payload["kind"], "image")
        self.assertEqual(payload["image"]["id"], "source-media")
        self.assertNotIn("video", payload)
        self.assertEqual(payload["latitude"], 35.0)
        self.assertNotIn("latitude", payload["source_metadata"])

    def test_video_payload_uses_poster_and_original_video(self) -> None:
        payload = module.content_payload(
            asset("video"),
            album_id="album-id",
            source_media_id="video-media",
            poster_media_id="poster-media",
            metadata={"captured_at": None, "location": {}},
            source_sha256="sha",
        )
        self.assertEqual(payload["kind"], "video")
        self.assertEqual(payload["image"]["id"], "poster-media")
        self.assertEqual(payload["video"]["id"], "video-media")
        self.assertNotIn("latitude", payload)

    def test_extract_metadata_does_not_expose_coordinates_for_invalid_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "not-media.jpg"
            path.write_bytes(b"not media")
            metadata = module.extract_metadata(path)
        self.assertEqual(metadata["location"], {})
        self.assertIsNone(metadata["captured_at"])

    def test_source_extension_is_stable(self) -> None:
        self.assertEqual(module.source_extension(asset()), ".jpg")
        self.assertEqual(module.source_extension(asset("video")), ".mp4")

    def test_public_media_path_uses_worker_route_and_escapes_storage_key(self) -> None:
        self.assertEqual(
            module.public_media_path("01ABC photo.jpg"),
            "/_emdash/api/media/file/01ABC%20photo.jpg",
        )

    def test_album_payload_uses_manifest_dates_and_source_identity(self) -> None:
        payload = module.album_content_payload(
            {
                "title": "Kyoto",
                "slug": "kyoto",
                "sort_method": "Position",
                "sort_direction": "Ascending",
                "source": {
                    "album_key": "album-key",
                    "web_uri": "https://example.test/kyoto",
                },
            },
            [asset()],
        )
        self.assertEqual(payload["source_album_key"], "album-key")
        self.assertEqual(payload["captured_from"], "2024-06-01T00:00:00Z")
        self.assertEqual(payload["captured_to"], "2024-06-01T00:00:00Z")
        self.assertEqual(payload["sort_method"], "position")
        self.assertEqual(payload["sort_direction"], "asc")


if __name__ == "__main__":
    unittest.main()
