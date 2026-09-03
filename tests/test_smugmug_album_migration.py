from __future__ import annotations

import importlib.util
import hashlib
import io
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


class OwnerClient:
    owner_authenticated = True

    def __init__(self, urls: list[str] | None = None) -> None:
        self.urls = iter(urls or ["https://example.test/original.jpg"])

    def get(self, path: str) -> dict:
        return {
            "ImageSizeDetails": {
                "ImageSizeOriginal": {
                    "Url": next(self.urls),
                    "OwnerOnly": True,
                }
            }
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
                "exif": {"Make": "Google", "Model": "Pixel"},
            },
            source_sha256="sha",
        )
        self.assertEqual(payload["kind"], "image")
        self.assertEqual(payload["image"]["id"], "source-media")
        self.assertNotIn("video", payload)
        self.assertEqual(payload["latitude"], 35.0)
        self.assertNotIn("latitude", payload["source_metadata"])
        self.assertEqual(
            payload["source_metadata"]["exif"],
            {"Make": "Google", "Model": "Pixel"},
        )
        self.assertEqual(payload["source_metadata"]["source_title"], "Title")
        self.assertEqual(payload["source_metadata"]["source_filename"], "source.jpg")

    def test_untitled_photo_keeps_internal_filename_but_marks_title_as_absent(self) -> None:
        candidate = asset()
        candidate["display"]["title"] = ""
        payload = module.content_payload(
            candidate,
            album_id="album-id",
            source_media_id="source-media",
            poster_media_id=None,
            metadata={"captured_at": None, "location": {}},
            source_sha256="sha",
        )
        self.assertEqual(payload["title"], "source.jpg")
        self.assertIsNone(payload["source_metadata"]["source_title"])
        self.assertEqual(payload["source_metadata"]["source_filename"], "source.jpg")

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
        self.assertEqual(metadata["exif"], {})

    def test_source_extension_is_stable(self) -> None:
        self.assertEqual(module.source_extension(asset()), ".jpg")
        self.assertEqual(module.source_extension(asset("video")), ".mp4")

    def test_download_source_requires_owner_auth_when_public_bytes_are_not_original(self) -> None:
        expected = b"original image bytes"
        public_derivative = b"public derivative bytes"
        live = {
            "ArchivedUri": "https://example.test/archive.jpg",
            "ArchivedMD5": hashlib.md5(expected).hexdigest(),
        }
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.jpg"
            with patch.object(
                module, "urlopen", return_value=io.BytesIO(public_derivative)
            ):
                with self.assertRaises(module.OwnerAuthenticationRequired):
                    module.download_source(
                        live,
                        hashlib.md5(expected).hexdigest(),
                        destination,
                    )
            self.assertFalse(destination.exists())

    def test_owner_download_accepts_missing_frozen_md5_when_live_digest_matches(self) -> None:
        original = b"owner-only original"
        live = {
            "ArchivedMD5": hashlib.md5(original).hexdigest(),
            "ArchivedSize": len(original),
            "Uris": {"ImageSizeDetails": {"Uri": "/api/v2/image/test!sizedetails"}},
        }
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.jpg"
            with patch.object(module, "urlopen", return_value=io.BytesIO(original)):
                receipt = module.download_source(
                    live, "", destination, client=OwnerClient()
                )
        self.assertTrue(receipt["reported_md5_match"])
        self.assertFalse(receipt["repeated_download_match"])
        self.assertEqual(receipt["download_method"], "owner_image_size_original")

    def test_owner_download_revalidates_stable_raw_bytes_when_reported_md5_differs(self) -> None:
        reported = b"archived object"
        downloadable = b"stable raw media"
        live = {
            "ArchivedMD5": hashlib.md5(reported).hexdigest(),
            "ArchivedSize": len(reported),
            "Uris": {"ImageSizeDetails": {"Uri": "/api/v2/image/test!sizedetails"}},
        }
        client = OwnerClient(
            ["https://example.test/first.jpg", "https://example.test/second.jpg"]
        )
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.jpg"
            with patch.object(
                module,
                "urlopen",
                side_effect=[io.BytesIO(downloadable), io.BytesIO(downloadable)],
            ):
                receipt = module.download_source(
                    live,
                    hashlib.md5(reported).hexdigest(),
                    destination,
                    client=client,
                )
        self.assertFalse(receipt["reported_md5_match"])
        self.assertTrue(receipt["repeated_download_match"])

    def test_owner_download_rejects_unstable_raw_bytes(self) -> None:
        reported = b"archived object"
        live = {
            "ArchivedMD5": hashlib.md5(reported).hexdigest(),
            "Uris": {"ImageSizeDetails": {"Uri": "/api/v2/image/test!sizedetails"}},
        }
        client = OwnerClient(
            ["https://example.test/first.jpg", "https://example.test/second.jpg"]
        )
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.jpg"
            with patch.object(
                module,
                "urlopen",
                side_effect=[io.BytesIO(b"first"), io.BytesIO(b"second")],
            ):
                with self.assertRaisesRegex(
                    module.AlbumMigrationError, "changed during revalidation"
                ):
                    module.download_source(
                        live,
                        hashlib.md5(reported).hexdigest(),
                        destination,
                        client=client,
                    )
            self.assertFalse(destination.exists())

    def test_owner_location_fills_map_fields_when_delivery_exif_has_none(self) -> None:
        merged = module.merge_owner_location(
            {"location": {}, "location_source": None, "captured_at": None, "exif": {}},
            {"Latitude": None, "Longitude": None},
            {
                "ImageMetadata": {
                    "Latitude": 35.0,
                    "Longitude": 135.0,
                    "Altitude": 25,
                }
            },
        )
        self.assertEqual(
            merged["location"],
            {"latitude": 35.0, "longitude": 135.0, "altitude": 25.0},
        )
        self.assertEqual(merged["location_source"], "smugmug_owner_api")

    def test_owner_location_treats_zero_zero_as_missing(self) -> None:
        original = {
            "location": {},
            "location_source": None,
            "captured_at": None,
            "exif": {},
        }
        merged = module.merge_owner_location(
            original,
            {"Latitude": 0, "Longitude": 0},
            {"ImageMetadata": {"Latitude": 0, "Longitude": 0}},
        )
        self.assertEqual(merged, original)

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

    def test_prefers_node_cover_over_highlight_for_album_cover(self) -> None:
        first = asset()
        first["source"]["image_key"] = "first"
        first["destination"] = {"emdash_media_id": "first-media"}
        first["verification"] = {"r2_roundtrip_verified": True}
        highlighted = asset()
        highlighted["id"] = "kph_highlighted"
        highlighted["source"]["image_key"] = "highlight"
        highlighted["destination"] = {"emdash_media_id": "highlight-media"}
        highlighted["verification"] = {"r2_roundtrip_verified": True}
        node_cover = asset()
        node_cover["id"] = "kph_node_cover"
        node_cover["source"]["image_key"] = "node-cover"
        node_cover["destination"] = {"emdash_media_id": "node-cover-media"}
        node_cover["verification"] = {"r2_roundtrip_verified": True}
        manifest = {
            "album": {
                "source": {
                    "cover_image_key": "node-cover",
                    "node_cover_image_key": "node-cover",
                    "highlight_image_key": "highlight",
                    "cover_image_source": "node_cover",
                }
            },
            "assets": [first, highlighted, node_cover],
        }
        self.assertEqual(
            module.preferred_cover_asset(manifest)["id"], "kph_node_cover"
        )

    def test_prefers_smugmug_highlight_for_album_cover(self) -> None:
        first = asset()
        first["source"]["image_key"] = "first"
        first["destination"] = {"emdash_media_id": "first-media"}
        first["verification"] = {"r2_roundtrip_verified": True}
        highlighted = asset()
        highlighted["id"] = "kph_highlighted"
        highlighted["source"]["image_key"] = "highlight"
        highlighted["destination"] = {"emdash_media_id": "highlight-media"}
        highlighted["verification"] = {"r2_roundtrip_verified": True}
        manifest = {
            "album": {"source": {"highlight_image_key": "highlight"}},
            "assets": [first, highlighted],
        }
        self.assertEqual(
            module.preferred_cover_asset(manifest)["id"], "kph_highlighted"
        )

    def test_falls_back_to_first_verified_asset_when_no_source_cover(self) -> None:
        first = asset()
        first["id"] = "kph_first"
        first["source"]["image_key"] = "first"
        first["destination"] = {"emdash_media_id": "first-media"}
        first["verification"] = {"r2_roundtrip_verified": True}
        second = asset()
        second["id"] = "kph_second"
        second["source"]["image_key"] = "second"
        second["destination"] = {"emdash_media_id": "second-media"}
        second["verification"] = {"r2_roundtrip_verified": True}
        manifest = {"album": {"source": {}}, "assets": [first, second]}
        self.assertEqual(module.preferred_cover_asset(manifest)["id"], "kph_first")

    def test_ensure_album_cover_updates_published_image_without_media_upload(self) -> None:
        cover = asset()
        cover["id"] = "kph_cover"
        cover["source"]["image_key"] = "node-cover"
        cover["display"]["alt"] = "Izumo rope"
        cover["destination"] = {"emdash_media_id": "node-cover-media"}
        cover["verification"] = {"r2_roundtrip_verified": True}
        first = asset()
        first["source"]["image_key"] = "first"
        first["destination"] = {"emdash_media_id": "first-media"}
        first["verification"] = {"r2_roundtrip_verified": True}
        manifest = {
            "album": {
                "destination": {"emdash_content_id": "album-id"},
                "source": {
                    "cover_image_key": "node-cover",
                    "node_cover_image_key": "node-cover",
                },
            },
            "assets": [first, cover],
        }
        commands: list[list[str]] = []

        def fake_get(collection, identifier, *, env, token, published=False):
            if published and commands:
                return {
                    "data": {"cover_image": {"id": "node-cover-media"}},
                    "_rev": "rev-published",
                }
            return {
                "data": {"cover_image": {"id": "first-media"}},
                "_rev": "rev-1",
            }

        def fake_run(args, env, *, token):
            commands.append(list(args))
            return {}

        with (
            patch.object(module, "get_content_by_identifier", side_effect=fake_get),
            patch.object(module, "run_emdash", side_effect=fake_run) as run,
            patch.object(module, "upload_media") as upload,
        ):
            changed = module.ensure_album_cover(manifest, env={}, token="token")
        self.assertTrue(changed)
        upload.assert_not_called()
        self.assertEqual(run.call_count, 2)
        self.assertEqual(commands[0][:3], ["content", "update", "albums"])
        self.assertEqual(json.loads(commands[0][commands[0].index("--data") + 1]), {
            "cover_image": {
                "id": "node-cover-media",
                "provider": "local",
                "alt": "Izumo rope",
            }
        })
        self.assertEqual(commands[1], ["content", "publish", "albums", "album-id"])

    def test_ensure_album_cover_publishes_stale_public_cover_without_reupload(self) -> None:
        cover = asset()
        cover["source"]["image_key"] = "node-cover"
        cover["destination"] = {"emdash_media_id": "node-cover-media"}
        cover["verification"] = {"r2_roundtrip_verified": True}
        manifest = {
            "album": {
                "destination": {"emdash_content_id": "album-id"},
                "source": {"cover_image_key": "node-cover"},
            },
            "assets": [cover],
        }
        commands: list[list[str]] = []

        def fake_get(collection, identifier, *, env, token, published=False):
            if published and not commands:
                return {
                    "data": {"cover_image": {"id": "first-media"}},
                    "_rev": "rev-published",
                }
            if published:
                return {
                    "data": {"cover_image": {"id": "node-cover-media"}},
                    "_rev": "rev-published",
                }
            return {
                "data": {"cover_image": {"id": "node-cover-media"}},
                "_rev": "rev-draft",
            }

        with (
            patch.object(module, "get_content_by_identifier", side_effect=fake_get),
            patch.object(
                module, "run_emdash", side_effect=lambda args, env, token: commands.append(list(args))
            ) as run,
            patch.object(module, "upload_media") as upload,
        ):
            changed = module.ensure_album_cover(manifest, env={}, token="token")
        self.assertTrue(changed)
        upload.assert_not_called()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(commands, [["content", "publish", "albums", "album-id"]])
        cover = asset()
        cover["source"]["image_key"] = "node-cover"
        cover["destination"] = {"emdash_media_id": "node-cover-media"}
        cover["verification"] = {"r2_roundtrip_verified": True}
        manifest = {
            "album": {
                "destination": {"emdash_content_id": "album-id"},
                "source": {"cover_image_key": "node-cover"},
            },
            "assets": [cover],
        }
        with (
            patch.object(
                module,
                "get_content_by_identifier",
                return_value={
                    "data": {"cover_image": {"id": "node-cover-media"}},
                    "_rev": "rev-1",
                },
            ),
            patch.object(module, "run_emdash") as run,
            patch.object(module, "upload_media") as upload,
        ):
            changed = module.ensure_album_cover(manifest, env={}, token="token")
        self.assertFalse(changed)
        run.assert_not_called()
        upload.assert_not_called()

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
