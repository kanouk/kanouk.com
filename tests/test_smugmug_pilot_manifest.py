from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = (
    Path(__file__).parents[1] / "scripts/migration/build_smugmug_pilot_manifest.py"
)
SPEC = importlib.util.spec_from_file_location("build_smugmug_pilot_manifest", MODULE_PATH)
assert SPEC and SPEC.loader
manifest_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manifest_module)


class SmugMugPilotManifestTests(unittest.TestCase):
    def sample(self) -> dict:
        return {
            "ImageKey": "abc123",
            "FileName": "photo.JPG",
            "Format": "JPG",
            "ArchivedUri": "https://signed.example/original?APIKey=secret",
            "ArchivedMD5": "d41d8cd98f00b204e9800998ecf8427e",
            "Latitude": 35.0,
            "Longitude": 135.0,
            "WebUri": "https://example.smugmug.com/album/i-abc123",
            "Title": "A title",
            "Caption": "A caption",
            "Position": 2,
            "OriginalWidth": 100,
            "OriginalHeight": 50,
            "ArchivedSize": 42,
            "DateTimeOriginal": "2024-06-07T12:34:56",
        }

    def test_stable_id_is_deterministic_and_opaque(self) -> None:
        first = manifest_module.stable_id("kph", "smugmug-image", "abc123")
        second = manifest_module.stable_id("kph", "smugmug-image", "abc123")
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("kph_"))
        self.assertNotIn("abc123", first)

    def test_asset_omits_signed_uri_and_geolocation(self) -> None:
        asset = manifest_module.sanitized_asset(self.sample(), 1)
        manifest_module.assert_sanitized(asset)
        serialized = str(asset)
        self.assertNotIn("signed.example", serialized)
        self.assertNotIn("Latitude", serialized)
        self.assertNotIn("Longitude", serialized)
        self.assertEqual(asset["source"]["archived_md5"], "d41d8cd98f00b204e9800998ecf8427e")

    def test_collected_asset_uses_album_scoped_stable_id(self) -> None:
        image = self.sample()
        image["CollectedFrom"] = {"Uri": "/api/v2/image/original"}
        first = manifest_module.sanitized_asset(image, 1, album_key="album-a")
        second = manifest_module.sanitized_asset(image, 1, album_key="album-b")
        self.assertNotEqual(first["id"], second["id"])
        self.assertTrue(first["source"]["collected"])

    def test_manifest_has_fixed_url_contract_and_source_order(self) -> None:
        first = self.sample()
        first["ImageKey"] = "first"
        first["Position"] = 2
        second = self.sample()
        second["ImageKey"] = "second"
        second["Position"] = 1
        album = {
            "AlbumKey": "album-key",
            "Title": "Kyoto",
            "WebUri": "https://example.smugmug.com/kyoto",
        }
        payload = manifest_module.manifest(
            album,
            [first, second],
            user="kanolog",
            slug="2024-06-kyoto",
            highlight_image_key="second",
            node_cover_image_key="first",
        )
        self.assertEqual(payload["url_contract"]["album_path"], "/albums/2024-06-kyoto")
        self.assertEqual(payload["assets"][0]["source"]["image_key"], "second")
        self.assertEqual(payload["album"]["asset_count"], 2)
        self.assertEqual(
            payload["album"]["source"]["highlight_image_key"], "second"
        )
        self.assertEqual(
            payload["album"]["source"]["node_cover_image_key"], "first"
        )
        self.assertEqual(
            payload["album"]["source"]["cover_image_key"], "first"
        )
        self.assertEqual(
            payload["album"]["source"]["cover_image_source"], "node_cover"
        )
        self.assertEqual(
            payload["assets"][0]["timestamps"]["captured_at"]["timezone_status"],
            "unknown",
        )

    def test_cover_priority_prefers_node_cover_then_highlight_then_first(self) -> None:
        self.assertEqual(
            manifest_module.resolve_album_cover_source("node", "highlight", "first"),
            ("node", "node_cover"),
        )
        self.assertEqual(
            manifest_module.resolve_album_cover_source(None, "highlight", "first"),
            ("highlight", "highlight"),
        )
        self.assertEqual(
            manifest_module.resolve_album_cover_source(None, None, "first"),
            ("first", "first_asset"),
        )
        self.assertEqual(
            manifest_module.resolve_album_cover_source(None, None, None),
            (None, None),
        )

    def test_image_key_from_response_reads_cover_and_highlight_envelopes(self) -> None:
        self.assertEqual(
            manifest_module.image_key_from_response(
                {"Image": {"ImageKey": "cover-key"}}
            ),
            "cover-key",
        )
        self.assertIsNone(manifest_module.image_key_from_response({"Image": {}}))
        self.assertIsNone(manifest_module.image_key_from_response({"Locator": "Image"}))

    def test_rejects_credential_bearing_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "Credential-bearing URL"):
            manifest_module.assert_sanitized({"url": "https://example/?APIKey=secret"})

    def test_regeneration_preserves_verified_progress_for_same_source(self) -> None:
        album = {"source": {"album_key": "album"}}
        fresh = {
            "album": album,
            "assets": [
                {
                    "id": "kph_same",
                    "source": {"image_key": "image", "archived_md5": "md5"},
                    "destination": {"r2_object_key": None},
                    "verification": {"source_md5_verified": False},
                }
            ],
        }
        existing = {
            "album": album,
            "assets": [
                {
                    "id": "kph_same",
                    "source": {"image_key": "image", "archived_md5": "md5"},
                    "destination": {
                        "r2_object_key": "object.jpg",
                        "poster_media_id": "poster-id",
                        "poster_r2_object_key": "poster.jpg",
                    },
                    "verification": {
                        "source_md5_verified": True,
                        "sha256": "sha",
                        "r2_roundtrip_verified": True,
                    },
                }
            ],
        }
        merged = manifest_module.merge_verified_progress(fresh, existing)
        self.assertEqual(merged["assets"][0]["destination"]["r2_object_key"], "object.jpg")
        self.assertEqual(merged["assets"][0]["destination"]["poster_media_id"], "poster-id")
        self.assertEqual(merged["assets"][0]["verification"]["sha256"], "sha")

    def test_regeneration_preserves_existing_id_when_collected_state_changes(self) -> None:
        album = {"source": {"album_key": "album"}}
        fresh = {
            "album": album,
            "assets": [
                {
                    "id": "new-context-id",
                    "source": {"image_key": "image", "archived_md5": "md5"},
                    "destination": {
                        "photo_path": "/photos/new-context-id",
                        "media_path": "/media/new-context-id",
                    },
                    "verification": {"source_md5_verified": False},
                }
            ],
        }
        existing = {
            "album": album,
            "assets": [
                {
                    "id": "published-id",
                    "source": {"image_key": "image", "archived_md5": "md5"},
                    "destination": {
                        "photo_path": "/photos/published-id",
                        "media_path": "/media/published-id",
                    },
                    "verification": {"source_md5_verified": False},
                }
            ],
        }
        merged = manifest_module.merge_verified_progress(fresh, existing)
        self.assertEqual(merged["assets"][0]["id"], "published-id")
        self.assertEqual(
            merged["assets"][0]["destination"]["photo_path"],
            "/photos/published-id",
        )

    def test_regeneration_preserves_owner_auth_pending_reason(self) -> None:
        album = {"source": {"album_key": "album"}}
        fresh = {
            "album": album,
            "assets": [
                {
                    "id": "asset",
                    "source": {"image_key": "image", "archived_md5": "md5"},
                    "destination": {},
                    "verification": {"source_md5_verified": False},
                }
            ],
        }
        existing = {
            "album": album,
            "assets": [
                {
                    "id": "asset",
                    "source": {"image_key": "image", "archived_md5": "md5"},
                    "destination": {},
                    "verification": {
                        "source_md5_verified": False,
                        "migration_status": "pending_owner_auth",
                        "owner_auth_reason": "public_archive_unavailable",
                    },
                }
            ],
        }
        merged = manifest_module.merge_verified_progress(fresh, existing)
        self.assertEqual(
            merged["assets"][0]["verification"]["migration_status"],
            "pending_owner_auth",
        )


if __name__ == "__main__":
    unittest.main()
