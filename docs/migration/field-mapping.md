# フィールド対応と移行規則

更新日: 2026-09-02

これは実装済みの対応表です。未知の値を捨てず、公開表示に必要な値をEmDashの型へ正規化し、移行元の識別子とraw metadataも残します。

## WordPress → EmDash

| WordPress | EmDash | 実装規則 |
|---|---|---|
| `post` | `posts` | slugと公開状態を保持してimport |
| `page` | `pages` | slugと公開状態を保持してimport |
| `title` | `title:string` | HTML entityを正規化 |
| Gutenberg `content` | `content:portableText` | 標準ブロックはPortable Text、固有表現は`yohaku.*`へ変換 |
| `excerpt` | `excerpt:text` | 値がある場合に保持 |
| `_thumbnail_id` | `featured_image:image` | verified attachmentのEmDash media IDへ解決 |
| `status` | content status + `source_metadata` | publishのみ公開。draft/privateは非公開状態を保持 |
| `date` / `date_gmt` | published time | WordPressの時刻情報を保持 |
| `modified` / `modified_gmt` | updated time | WordPressの時刻情報を保持 |
| category / tag / taxonomy | taxonomy情報 | slug・階層・割当をsource metadataと変換結果へ保持 |
| comments | comments | approvedだけ公開。pendingは非公開で保持し、IP/User-Agentは除外 |
| postmeta | typed block fields + `source_metadata` | 既知の表現は意味フィールドへ変換し、監査に必要な元値を保持 |
| attachment | EmDash media / R2 | source byteとCloudflare readbackのSHA-256一致後だけverified |

### WordPress固有ブロック

WordPressテーマ名やプラグイン名を新しい名前空間へ残しません。表現の意味を基準に次へ変換します。

| 元の表現 | Yohakuブロック |
|---|---|
| FAQ、開閉、アコーディオン | `yohaku.accordion` |
| 補足、注意、案内ボックス | `yohaku.callout` |
| 吹き出し、会話 | `yohaku.dialogue` |
| 外部／内部リンクカード | `yohaku.linkCard` |
| Pochipp、商品紹介 | `yohaku.productCard` |
| 評価、星、レーティング | `yohaku.rating` |
| クイズ | `yohaku.quiz` |
| サイト内検索フォーム | `yohaku.siteSearch` |
| 手順、ステップ | `yohaku.steps` |

全1,854コンテンツの変換監査は16,701ブロック、通常の`htmlBlock` 0件です。Gutenberg引用370件はnested paragraph/listを保つ`yohaku.quote`へまとめるため、修正前よりblock総数が減っています。今後未知ブロックが見つかった場合も、即座にHTMLへ固定せず、意味ブロック追加か安全な標準表現への分解を優先します。

## WordPress添付 → media

| source | 保存先・台帳 | 規則 |
|---|---|---|
| attachment ID | `source_id` | 再実行時の主キーとして保持 |
| attachment URL | `source_url` / `url_mappings` | 本文、`srcset`、リンクの解決に使用 |
| filename / MIME | media metadata | GIF、SVG、PDF、XLSX、MP3も画像扱いにしない |
| source byte | R2 object | download SHA-256を記録 |
| R2 readback byte | ledger | source SHA-256と一致した場合だけ`verified` |
| alt / caption / title | media metadata | 空値を推測で補わない |

本文のURL置換は文字列一括置換ではなく、Portable Text node、HTML属性、`srcset`、Gutenberg comment、shortcodeの位置ごとに解決します。media未検証の参照は旧URLのまま残し、壊れた新URLを生成しません。

## SmugMug album → `albums`

| SmugMug | EmDash | 実装規則 |
|---|---|---|
| `AlbumKey` | `source_album_key` | source identityとして保持 |
| `Name` / `Title` | `title` | 表示名を保持 |
| `Description` | `description` | 値がある場合に保持 |
| highlight / node cover image | `cover_image` | 一覧タイルは`NodeCoverImage`を優先。無い場合だけ`HighlightImage`。どちらも無い場合のみ移行済み先頭画像。source image keyはmanifestへ保存し、既存アルバムへ再適用する |
| first/last capture time | `captured_from` / `captured_to` | verified assetから算出 |
| `SortMethod` | `sort_method` | 撮影日順または手動positionを保持 |
| `SortDirection` | `sort_direction` | asc / descを保持 |
| `AllowDownloads` | `allow_downloads` | UIと配信可否の双方で尊重 |
| `WebUri` | `source_url` | 旧新URL台帳に記録 |
| その他のsource fields | `source_metadata` | 機能・監査に必要なraw値を保持 |

## SmugMug image / video → `photos`

| SmugMug | EmDash | 実装規則 |
|---|---|---|
| `ImageKey` / stable ID | `source_id` | 固定photo slugの根拠 |
| image / video | `kind` | `image`または`video` |
| verified image byte | `image` | 画像本体。動画ではposterも保持 |
| verified MP4 | `video` | file fieldへ保存しRange再生を確認 |
| `Title` | `title` | 空の場合のみ決定的な代替名 |
| accessibility text | `alt` | title/caption/filenameから決定的に生成しrequiredを満たす |
| `Caption` | `caption` | 値を保持 |
| album | `album` | `albums` reference |
| source order | `position` | 手動順を含め、そのまま保持 |
| `DateTimeOriginal` | `captured_at` | 撮影時刻を優先 |
| GPS EXIF | `latitude` / `longitude` / `altitude` | 削除せず正規化し、地図へ利用 |
| `ArchivedMD5` | verification metadata | 公開取得byteとの一致判定に使用 |
| source byte | R2 + `original_sha256` | SHA-256を記録しreadbackと一致確認 |
| EXIF / keyword / source fields | `source_metadata` | EXIF表示・検索・監査に使用 |

重要な規則:

- 公開画像の見た目が正常でも`ArchivedMD5`と違えば原本として採用しない。
- 公開archive URIなし、またはMD5不一致は`pending_owner_auth`にして所有者OAuth後に再取得する。
- 同じ実体とhashで確認できた場合だけ重複排除する。見た目が似ているだけでは統合しない。
- GPSとEXIFはユーザー方針により保持し、写真詳細とアルバム地図へ公開する。
- 36アルバムのdownload許可と4アルバムの不許可を新UIでも維持する。
- private/Gyazo代替mediaはIssue #2の別認証境界で扱い、今回の公開collectionへ追加しない。

## URL対応台帳

`url_mappings`は次を保持します。

```text
source_url       旧WordPress / SmugMug URL（unique）
target_url       新しい固定URL
target_kind      post | page | album | photo | media | attachment
source_system    wordpress | smugmug
source_record_id 移行元ID
migration_status pending | migrated | blocked | excluded
verified         公開readbackまで確認済みか
```

監査対象hostは、3サイトの`wp-content/uploads`、`kanolog.smugmug.com`、`photos.smugmug.com`です。本文media確定後の再importで旧参照を同時に置換し、2回目のimportが`skipped_verified`になることを冪等性の合格条件にします。

## 公開URL

| 対象 | 正式URL |
|---|---|
| カノログ一覧・記事 | `https://blog.kanouk.com/...` |
| 公開アルバム | `https://photos.kanouk.com/albums/...` |
| 公開写真・動画 | `https://photos.kanouk.com/p/...` |
| media byte | 生のR2管理URLを出さずWorker配信URLを使用 |

旧WordPress記事は可能な限りpathを維持します。custom domain DNSは全件監査合格後にユーザーが明示承認済みです。旧domain側の301は旧ホスト側の管理条件と外部参照を確認してから別工程で設定し、旧サービスの停止・解約とは分離します。
