from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


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

    def test_reconcile_existing_image_restores_manifest_destination(self) -> None:
        candidate = asset()
        candidate["destination"] = {}
        module.reconcile_existing_asset(
            candidate,
            {
                "id": "content-id",
                "data": {
                    "source_system": "smugmug",
                    "source_id": "source-key",
                    "original_sha256": "sha",
                    "kind": "image",
                    "album": "album-id",
                    "source_metadata": {"stable_media_id": "kph_test"},
                    "image": {
                        "id": "media-id",
                        "meta": {"storageKey": "object.jpg"},
                    },
                },
            },
            album_id="album-id",
            source_sha256="sha",
        )
        self.assertEqual(candidate["destination"]["emdash_content_id"], "content-id")
        self.assertEqual(candidate["destination"]["emdash_media_id"], "media-id")
        self.assertEqual(candidate["destination"]["r2_object_key"], "object.jpg")
        self.assertEqual(
            candidate["destination"]["media_path"],
            "/_emdash/api/media/file/object.jpg",
        )

    def test_reconcile_rejects_wrong_source(self) -> None:
        candidate = asset()
        with self.assertRaises(module.AlbumMigrationError):
            module.reconcile_existing_asset(
                candidate,
                {
                    "id": "content-id",
                    "data": {
                        "source_system": "smugmug",
                        "source_id": "different-source",
                        "original_sha256": "sha",
                        "kind": "image",
                        "album": "album-id",
                        "source_metadata": {"stable_media_id": "kph_test"},
                        "image": {
                            "id": "media-id",
                            "meta": {"storageKey": "object.jpg"},
                        },
                    },
                },
                album_id="album-id",
                source_sha256="sha",
            )

    def test_upload_media_retries_service_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.jpg"
            path.write_bytes(b"image")
            with (
                patch.object(
                    module,
                    "direct_media_upload",
                    side_effect=[
                        module.AlbumMigrationError("Service Unavailable"),
                        {"id": "media-id", "storageKey": "object.jpg"},
                    ],
                ) as run,
                patch.object(module.time, "sleep"),
            ):
                result = module.upload_media(
                    path, alt="Alt", env={}, token="secret-token"
                )
        self.assertEqual(result["id"], "media-id")
        self.assertEqual(run.call_count, 2)

    def test_content_read_retries_transient_503(self) -> None:
        with (
            patch.object(
                module.subprocess,
                "run",
                side_effect=[
                    subprocess.CompletedProcess(
                        [], 1, stdout="", stderr="ERROR HTTP 503"
                    ),
                    subprocess.CompletedProcess(
                        [], 0, stdout=json.dumps({"id": "content-id"}), stderr=""
                    ),
                ],
            ) as run,
            patch.object(module.time, "sleep"),
        ):
            result = module.get_content_by_identifier(
                "photos", "photo-slug", env={}, token="secret-token"
            )
        self.assertEqual(result, {"id": "content-id"})
        self.assertEqual(run.call_count, 2)

    def test_photo_create_recovers_exact_existing_record_after_503(self) -> None:
        candidate = asset()
        data = module.content_payload(
            candidate,
            album_id="album-id",
            source_media_id="media-id",
            poster_media_id=None,
            metadata={"captured_at": None, "location": {}},
            source_sha256="sha",
        )
        existing = {"id": "content-id", "data": data}
        with (
            patch.object(
                module,
                "run_emdash",
                side_effect=module.AlbumMigrationError("ERROR HTTP 503"),
            ),
            patch.object(
                module, "get_content_by_identifier", return_value=existing
            ),
        ):
            result = module.create_content(candidate, data, env={}, token="token")
        self.assertEqual(result["id"], "content-id")

    def test_finalize_pending_media_requires_hash_and_one_d1_change(self) -> None:
        source = b"verified bytes"
        pending = {
            "id": "media-id",
            "status": "pending",
            "storageKey": "object.jpg",
            "size": len(source),
            "contentHash": "sha1:" + hashlib.sha1(source).hexdigest(),
        }
        with (
            patch.object(
                module,
                "public_sha256",
                return_value=(hashlib.sha256(source).hexdigest(), len(source)),
            ),
            patch.object(module, "guarded_cloudflare_environment", return_value={}),
            patch.object(
                module.subprocess,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, stdout=json.dumps([{"meta": {"changes": 1}}]), stderr=""
                ),
            ),
            patch.object(
                module,
                "media_api_json",
                return_value={
                    "item": {
                        **pending,
                        "status": "ready",
                    }
                },
            ),
        ):
            result = module.finalize_pending_media(
                pending,
                source_bytes=source,
                alt="Alt",
                width=10,
                height=20,
                token="token",
            )
        self.assertEqual(result["status"], "ready")

    def test_finalize_pending_media_rejects_wrong_hash_before_d1(self) -> None:
        with self.assertRaises(module.AlbumMigrationError):
            module.finalize_pending_media(
                {
                    "id": "media-id",
                    "status": "pending",
                    "storageKey": "object.jpg",
                    "size": 3,
                    "contentHash": "sha1:wrong",
                },
                source_bytes=b"abc",
                alt="Alt",
                width=None,
                height=None,
                token="token",
            )


if __name__ == "__main__":
    unittest.main()
