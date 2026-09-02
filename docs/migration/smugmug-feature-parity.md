# SmugMug閲覧機能の精査

対象はGoogle Photosの代替ではなく、インターネットへ公開するアルバムとブログ埋め込みです。SmugMug製品全体ではなく、購入以外の閲覧体験を `photos.kanouk.com` へ移します。

## source実測（2026-09-02）

| 項目 | 実測 |
|---|---:|
| アルバム | 40 |
| アセット | 2,168 |
| JPEG / MP4 | 2,156 / 12 |
| title / caption | 934 / 687 |
| GPS | 1,114 |
| keyword | 2 |
| comment | 0 |
| download許可 / 不許可アルバム | 36 / 4 |
| protected album / asset | 7 / 339 |

## 閲覧機能の対応

| SmugMug側の機能 | Yohaku / EmDash側 | 状態 |
|---|---|---|
| アルバム一覧・詳細 | 安定slug、source順、title、description、件数 | 実装済み |
| highlight cover | `NodeCoverImage`を優先、無ければ`HighlightImage`、未取得時だけ先頭画像 | 実装・40件のsource key記録済み |
| 写真・動画詳細 | 固定ID、原寸比を保つ表示、MP4 controls/poster | 実装・全動画監査済み |
| Lightbox | Fullscreen APIによる全画面表示 | 実装済み |
| 前後移動 | link、左右キー、mobile swipe | 実装済み |
| slideshow | 6秒送り、再生／停止、reduced-motion対応 | 実装済み |
| title / caption / 撮影日 | 写真詳細へ表示 | 実装済み |
| EXIF | camera、lens、絞り、シャッター、ISO、焦点距離、露出補正 | 実装・backfill済み |
| 位置情報 | GPS保持、写真地図、アルバム全体のLeaflet地図 | 実装済み |
| 共有 | Web Share、clipboard fallback | 実装済み |
| download | source albumの`allow_downloads`をUIで尊重 | 実装済み |
| 検索 | album / photo / videoのtitle、caption、keywordをFTS検索 | 実装済み |
| keyword | 写真詳細のchipと検索 | 実装済み。source利用が2件のため専用一覧は作らない |
| comment | source全件監査で0件 | 移行対象なし |
| responsive cover | 一覧は`object-fit: cover`、低解像度だけ拡大しない | 実装済み |
| 個別写真 | `contain`で全体を表示し、原寸を超えて拡大しない | 実装済み |
| stable URL | source identityから固定album/photo ID、旧新台帳 | 実装・全件出力済み |
| SEO | title、description、OG、canonical、host別sitemap | 実装済み・custom domain監査待ち |

Lucide iconは検索、撮影情報、位置、共有、download、全画面、slideshow、前後移動、動画判別など意味のある操作に限定して使います。写真を主役にしつつ、単調な無機質さを避けます。

## 対象外

- 写真プリント・販売・price list・package・cart
- favorite（sourceの2,168件すべて`CanFavorite=false`）
- Lightroom等との同期
- watermark編集（source watermark利用0件）
- 顧客納品galleryとSmugMug同等のsite builder
- private/unlisted写真を公開すること
- Gyazo型upload shortcut、推測困難URL、password、API allowlist（Issue #2）

## 原本の扱い

- 公開ArchivedUriを使う場合は、取得byteが`ArchivedMD5`と一致したものだけをverifiedにする。
- ブラウザ表示できるJPEGでも公開byteのMD5が違えば、SmugMugが生成した派生版の可能性があるため公開経路からは採用しない。
- 公開archive URIなし、または公開byte不一致の資産はFull/Read owner OAuthで`ImageSizeOriginal`を解決する。owner APIが返すarchived MD5と配信byteが一致しない場合は、署名URLを新しく解決して二度取得し、二回のSHA-256とbyte数が完全一致したときだけ現在のowner原本として採用する。reported値とdownloaded値、再検証方法は台帳へ分けて記録する。
- R2 upload後に再取得してhashとsizeを再照合し、source hashとCloudflare readback hashを台帳へ残す。
- GPS EXIFはユーザー方針により保持し、地図機能へ利用する。

## 受け入れ条件

1. 40/40アルバム、2,168/2,168アセットにverified / pending / excludedの説明可能な最終状態がある。
2. 件数、position、highlight cover、title、caption、撮影日時がsourceと一致する。
3. JPEGとMP4がdesktop / 390px mobileで表示・再生できる。
4. 全画面、左右キー、swipe、slideshow、共有、download policy、検索、地図、EXIFが使える。
5. 一覧coverはデザイン優先でcropし、個別写真は全体を表示する。低解像度画像を無理に拡大しない。
6. ブログ埋め込みから旧SmugMug host参照が消え、固定URLへ一意に解決できる。
7. 原本とCloudflareから再取得したbyteのhashが一致する。
8. 本番切替後もSmugMugを解約せず、ユーザーの別途判断まで併存する。
