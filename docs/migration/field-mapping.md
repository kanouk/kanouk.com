# フィールド対応と正規データモデル

この文書は実装前の契約案です。未知の値を捨てず、移行元の識別子とraw metadataを保持したうえで、公開表示に必要な項目だけを正規化します。

## WordPress → EmDash

| WordPress | EmDash | 方針 |
|---|---|---|
| `post` | `posts` collection | 既定mappingを使用 |
| `page` | `pages` collection | 既定mappingを使用 |
| `pochipps` | `pochipps` collectionまたは商品参照テーブル | WXRでmeta構造を確定後に決める |
| `blog_parts` | `blog_parts` collectionまたはsection | 1件の用途をpilotで確認 |
| `wp_block` | section | EmDash既定の再利用ブロック変換を使用 |
| `nav_menu_item` | menus | WXR menu構造から変換 |
| `title` | `title:string` | そのまま |
| `content` | `content:portableText` | Gutenberg converter。未対応は`htmlBlock` |
| `excerpt` | `excerpt:text` | そのまま |
| `_thumbnail_id` | `featured_image:image` | attachment IDからmedia参照へ解決 |
| `status` | content status | publish以外は公開しない。privateの挙動をpilotで検証 |
| `date`, `date_gmt` | published/scheduled time | タイムゾーンを保持 |
| `modified`, `modified_gmt` | updated time | タイムゾーンを保持 |
| category/tag/custom taxonomy | taxonomy + term assignment | slug、階層、親子を保持 |
| comments | comments | status、parent、日時、author表示名を保持。個人情報の公開範囲は別確認 |
| postmeta | typed custom fields + raw metadata | allowlistで型付けし、未対応keyはrawに退避 |

## WordPress / SmugMug → 共通media_asset

```text
media_asset
  id                    UUID
  kind                  image | video | file
  visibility            public
  original_object_key   R2 key
  original_sha256       local verification hash
  source_md5            SmugMug ArchivedMD5 when present
  mime_type
  byte_size
  width / height
  captured_at
  uploaded_at
  title / caption / alt
  source_system         wordpress | smugmug
  source_id             attachment ID or ImageKey/Uri
  source_web_url
  source_metadata_json  lossless audit copy
  import_status
  verified_at
```

重要な規則:

- SmugMugの画像直リンクは署名や派生サイズが変わり得るため、恒久IDに使わない。
- WordPress attachment IDとSmugMug ImageKey/Uriは削除せず、source identityとして保持する。
- 同じ実体と確認できた場合だけhashで重複排除する。見た目が同じだけでは統合しない。
- EXIF・位置情報は移行時に保全しても、公開APIやHTMLへ自動露出させない。
- public以外のvisibilityをこのIssueで追加しない。private mediaはIssue #2の範囲。

## 公開アルバム

```text
album
  id
  slug
  title
  description
  cover_media_id
  sort_method           captured_at | position
  sort_direction        asc | desc
  allow_downloads
  published_at
  source_album_key
  source_uri
  source_web_url
  source_metadata_json

album_item
  album_id
  media_asset_id
  position
  title_override
  caption_override
```

SmugMugの35アルバムは撮影日順、5アルバムは手動順です。手動順は`album_item.position`へ必ず保存します。

## 派生画像・動画

```text
media_variant
  media_asset_id
  variant               thumb | small | medium | large | original | video-poster
  object_key
  mime_type
  byte_size
  width / height
  sha256
```

最初は原本と必要最小限のレスポンシブ派生だけを生成します。変換は再実行可能にし、原本を上書きしません。

## 参照・redirect台帳

```text
url_mapping
  source_url_normalized
  source_url_original
  target_url
  target_kind           post | page | album | media | attachment
  source_system
  source_record_id
  discovered_in
  migration_status
  verified_status
  last_checked_at
```

本文変換は文字列置換だけで行わず、HTML属性、`srcset`、Gutenberg comment、shortcode、Portable Text nodeを区別します。`kanolog.smugmug.com`、`photos.smugmug.com`、3サイトの`wp-content/uploads`を監査対象hostとします。

## URL方針

| 対象 | 新URL |
|---|---|
| ブログ一覧・記事 | `https://blog.kanouk.com/...` |
| 公開アルバム | `https://photos.kanouk.com/albums/...` |
| 公開写真ページ | `https://photos.kanouk.com/photos/...` |
| R2 object | ブラウザへ生のR2管理URLを出さず、公開配信URLを介す |

旧WordPress記事URLは可能な限り同じpathを新hostで保持します。旧domain側は移行完了後に1対1の301を設定します。SmugMug側で制御できない旧URLは、外部参照リストと検証結果を台帳に残します。
