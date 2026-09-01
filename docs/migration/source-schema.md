# 移行元とEmDashのデータ構造監査

更新日: 2026-09-02

この文書は、現在保存されている移行元原本と、ステージングへ実装済みのEmDashスキーマを記録します。件数は移行台帳の値であり、進行中の転送成功件数とは分けて扱います。

## WordPress

### 保存済み原本と現在値

- kanolog.net、nocalog.net、art-quiz.comのWXR原本をSHA-256付きで保存済み。
- WXRから投稿1,847件、固定ページ7件、合計1,854コンテンツを抽出済み。
- statusはpublish 1,848件、draft 3件、private 3件。非公開状態は移行先でも公開しない。
- 添付は2,027件。JPEG、PNG、GIF、WebP、SVG、PDF、XLSX、MP3を含む。
- コメントは127件（approved 65、pending 62）。IPアドレスとUser-Agentは移行しない。
- kanolog.netは所有者RESTでも監査済み。現在値は公開投稿1,370件、下書き1件、固定ページ3件、添付1,362件、Pochipp 590件、再利用ブロック3件、nav menu item 10件、公開コメント65件。
- kanolog.netのWXR後の公開投稿差分2件は、保存済みREST deltaと一致する。
- nocalog.netとart-quiz.comは公開REST件数がWXRの公開件数と一致する。現在の非公開差分は管理者認証がないため未確認だが、WXR内のdraft/privateは保持している。

### 本文構造

WXR本文にはGutenberg標準ブロックのほか、SWELL/LOOS、JIN、Pochipp、Jetpack、WPMF、クイズ、会話、商品カードなどのテーマ／プラグイン依存表現があります。

変換器はテーマ固有名を移行先へ持ち込まず、表現の意味に応じて次の `yohaku.*` ブロックへ正規化します。

- `yohaku.accordion`
- `yohaku.callout`
- `yohaku.dialogue`
- `yohaku.linkCard`
- `yohaku.productCard`
- `yohaku.rating`
- `yohaku.quiz`
- `yohaku.siteSearch`
- `yohaku.steps`

1,854コンテンツを17,055ブロックへ変換した監査では、通常のフォールバック `htmlBlock` は0件です。つまり「機械的にHTML化する」のではなく、標準Portable Textと汎用的なYohaku意味ブロックで保持します。

## SmugMug

### 公開カタログ実測

| 項目 | 件数・値 |
|---|---:|
| アルバム | 40 |
| アセット | 2,168 |
| JPEG / MP4 | 2,156 / 12 |
| source相当サイズ | 6,465,591,357 bytes |
| 公開`ArchivedUri` + `ArchivedMD5`あり | 2,003 |
| 公開archive URIなし | 165 |
| GPSあり | 1,114 |
| title / caption / keyword | 934 / 687 / 2 |
| download許可 / 不許可アルバム | 36 / 4 |
| protected album / asset | 7 / 339 |
| comment | 0 |

全アセットは公開サイト用途です。Google Photosの私的写真の代替や、Gyazo代替の半非公開領域はこのモデルへ混在させません。

### SmugMugで保持する構造

アルバムではsource identity、名前・説明、highlight、並び順、download可否、公開設定とraw metadataを保持します。写真・動画ではsource identity、ファイル名、形式、原本hash、寸法、撮影日時、title、caption、keyword、EXIF、GPS、album内positionとraw metadataを保持します。

GPSは削除しません。正規化した緯度・経度・高度を写真レコードへ保存し、写真詳細とアルバム地図に使います。公開JPEGが表示できてもsource MD5と一致しない場合は原本とみなさず、`pending_owner_auth`へ分類します。

## 実装済みEmDashスキーマ

ブログと写真は同じWorker / D1 / R2基盤を使いますが、collectionと公開画面を分けています。

### `posts`

- `title:string`（required/searchable）
- `featured_image:image`
- `content:portableText`（searchable）
- `excerpt:text`
- `source_url:string`（indexed）
- `source_id:string`（indexed）
- `source_metadata:json`

### `pages`

- `title:string`（required/searchable）
- `content:portableText`（searchable）
- `source_url:string`（indexed）
- `source_id:string`（indexed）
- `source_metadata:json`

### `albums`

- `title:string`（required/searchable）
- `description:text`（searchable）
- `cover_image:image`
- `captured_from:datetime` / `captured_to:datetime`
- `sort_method:string` / `sort_direction:string`
- `allow_downloads:boolean`
- `source_album_key:string`（indexed）
- `source_url:string`
- `source_metadata:json`

### `photos`

- `title:string`（required/searchable）
- `image:image`（required）
- `kind:select`（`image` / `video`）
- `video:file`
- `alt:string`（required）
- `caption:text`（searchable）
- `album:reference(albums)`（required/indexed）
- `position:integer`（required/indexed）
- `captured_at:datetime`
- `latitude:number` / `longitude:number` / `altitude:number`
- `source_system:string` / `source_id:string`（required、IDはindexed）
- `source_url:string`
- `original_sha256:string`（indexed）
- `source_metadata:json`

### `url_mappings`

- `source_url:string`（required/unique/indexed）
- `target_url:string`（required）
- `target_kind:string`（required）
- `source_system:string`（required）
- `source_record_id:string`
- `migration_status:string`
- `verified:boolean`

## 保存先と公開境界

```text
WordPress WXR / REST ─┐
                      ├─ manifest・ledger ─ EmDash content (D1) ─ blog UI
SmugMug API / OAuth ──┘                    └ media (R2) ───────── photos UI
```

- 公開ブログ名は「カノログ」、正式URLは `blog.kanouk.com`。
- 公開写真の正式URLは `photos.kanouk.com`。
- R2の管理URLは公開せず、Workerのmedia配信経路を使う。
- source ID、source URL、raw metadata、source hash、Cloudflare readback hashを残し、転送は中断・再実行可能にする。
- `fragrance.radio@gmail.com`側のCloudflare資源は使用しない。対象accountは`kanouk@gmail.com`。

## 最終状態と外部ゲート

- WordPressはWXR添付2,027件とarchiveから回収した1件、合計2,028件を全件転送・readback照合済み。1,854コンテンツの再importも全件`skipped_verified`、失敗0で冪等性を確認済み。
- SmugMugは2,168件すべてを転送・readback照合済み。owner OAuth待ち236件を原本一致へ収束し、2025-02京都記事のSmugMug 9参照も固定URLへ置換済み。
- 最終crawlは4,056 page／6,302 internal link、旧WordPress／SmugMug／未変換表現0件。
- custom domainのDNS切替はユーザー承認済み。registrar認証後にnameserverを変更し、公開readbackを行う。
