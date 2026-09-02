from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


REPO_ROOT = Path(__file__).parents[1]
SCRIPT_ROOT = REPO_ROOT / "scripts/migration"
SPEC = importlib.util.spec_from_file_location(
    "apply_smugmug_album_covers", SCRIPT_ROOT / "apply_smugmug_album_covers.py"
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def sample_manifest(
    *,
    slug: str,
    node_cover: str | None,
    highlight: str,
    first: str,
    assets: dict[str, str],
) -> dict:
    ordered = [(first, assets[first])]
    for key, media_id in assets.items():
        if key != first:
            ordered.append((key, media_id))
    return {
        "album": {
            "slug": slug,
            "title": slug,
            "source": {
                "album_key": slug,
                "node_cover_image_key": node_cover,
                "highlight_image_key": highlight,
            },
            "destination": {"emdash_content_id": f"{slug}-id"},
        },
        "assets": [
            {
                "id": f"kph_{key}",
                "source": {"image_key": key},
                "destination": {
                    "emdash_media_id": media_id,
                    "r2_object_key": f"{media_id}.jpg",
                },
                "verification": {"r2_roundtrip_verified": True},
            }
            for key, media_id in ordered
        ],
    }


class SmugMugAlbumCoverApplyTests(unittest.TestCase):
    def test_parses_public_album_card_preview_keys(self) -> None:
        parser = module.AlbumCoverParser()
        parser.feed(
            '<a class="album-card" href="/albums/2025-12-shimane-tottori">'
            '<div class="cover">'
            '<img src="/_yohaku/media/preview-v1/01COVER.01FILE.jpg" alt="出雲大社">'
            "</div><h2>Shimane/Tottori, 2025/12</h2></a>"
            '<a class="album-card" href="/albums/stations">'
            '<img src="/_yohaku/media/preview-v1/01STATION.jpg" alt="Stations">'
            "</a>"
        )
        self.assertEqual(
            parser.covers,
            {
                "2025-12-shimane-tottori": "01COVER.01FILE.jpg",
                "stations": "01STATION.jpg",
            },
        )

    def test_parses_low_resolution_cover_from_original_media_url(self) -> None:
        parser = module.AlbumCoverParser()
        parser.feed(
            '<a class="album-card" href="/albums/2005-05-kumamoto">'
            '<div class="cover">'
            '<img src="/_emdash/api/media/file/01MEDIA.01FILE.jpg" '
            'alt="熊本城" data-low-resolution="true">'
            "</div></a>"
        )
        self.assertEqual(
            parser.covers,
            {"2005-05-kumamoto": "01MEDIA.01FILE.jpg"},
        )

    def test_public_cover_match_accepts_storage_key_prefix(self) -> None:
        mismatches = module.public_covers_match(
            {"shimane": "01COVER.01FILE.jpg"},
            {"shimane": "01COVER.01FILE.jpg"},
        )
        self.assertEqual(mismatches, [])
        mismatches = module.public_covers_match(
            {"shimane": "01COVER.01FILE.jpg"},
            {"shimane": "01WRONG.jpg"},
        )
        self.assertEqual(len(mismatches), 1)

    def test_refresh_records_node_cover_without_touching_assets(self) -> None:
        manifest = sample_manifest(
            slug="stations",
            node_cover=None,
            highlight="highlight",
            first="first",
            assets={"first": "first-media", "node": "node-media", "highlight": "hi-media"},
        )
        asset_ids = [asset["id"] for asset in manifest["assets"]]

        class FakeClient:
            def get(self, path: str) -> dict:
                if path.endswith("!cover"):
                    return {"Image": {"ImageKey": "node"}}
                return {"Image": {"ImageKey": "highlight"}}

        album = {
            "Uris": {
                "NodeCoverImage": {"Uri": "/api/v2/node/abc!cover"},
                "HighlightImage": {"Uri": "/api/v2/highlight/node/abc"},
            }
        }
        changed = module.refresh_cover_fields(manifest, album, FakeClient())
        self.assertTrue(changed)
        source = manifest["album"]["source"]
        self.assertEqual(source["cover_image_key"], "node")
        self.assertEqual(source["cover_image_source"], "node_cover")
        self.assertEqual([asset["id"] for asset in manifest["assets"]], asset_ids)

    def test_recorded_catalog_covers_are_migrated_and_follow_source_priority(self) -> None:
        catalog = json.loads(
            (REPO_ROOT / "migration/smugmug/catalog.json").read_text()
        )
        self.assertEqual(len(catalog["albums"]), 40)
        sources: dict[str, int] = {}
        node_differs = 0
        for row in catalog["albums"]:
            manifest = json.loads(
                (REPO_ROOT / "migration/smugmug" / row["manifest"]).read_text()
            )
            source = manifest["album"]["source"]
            cover_key = source.get("cover_image_key")
            cover_source = source.get("cover_image_source")
            self.assertTrue(cover_key, row["slug"])
            self.assertIn(cover_source, {"node_cover", "highlight", "first_asset"})
            if cover_source == "node_cover":
                self.assertEqual(cover_key, source.get("node_cover_image_key"))
            elif cover_source == "highlight":
                self.assertIsNone(source.get("node_cover_image_key"))
                self.assertEqual(cover_key, source.get("highlight_image_key"))
            if source.get("node_cover_image_key") and source.get(
                "highlight_image_key"
            ) != source.get("node_cover_image_key"):
                node_differs += 1
            asset = next(
                item
                for item in manifest["assets"]
                if item["source"]["image_key"] == cover_key
            )
            self.assertTrue(asset["verification"]["r2_roundtrip_verified"], row["slug"])
            self.assertTrue(asset["destination"].get("emdash_media_id"), row["slug"])
            sources[cover_source] = sources.get(cover_source, 0) + 1
        self.assertEqual(sources.get("node_cover"), 34)
        self.assertEqual(sources.get("highlight"), 6)
        self.assertEqual(node_differs, 6)
        shimane = json.loads(
            (
                REPO_ROOT
                / "migration/smugmug/albums/2025-12-shimane-tottori/manifest.json"
            ).read_text()
        )
        self.assertEqual(shimane["album"]["source"]["cover_image_key"], "qF7S2SS")
        self.assertNotEqual(
            shimane["album"]["source"]["cover_image_key"],
            shimane["assets"][0]["source"]["image_key"],
        )


if __name__ == "__main__":
    unittest.main()
