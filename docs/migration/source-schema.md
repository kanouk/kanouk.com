# 移行元とEmDashのデータ構造監査

調査日: 2026-08-31

## 調査範囲

確認できた事実、本人の方針、設計上の提案を混同しないため、以下の記号を使います。

- **確認済み**: API、既存manifest、またはEmDash 0.35.0の配布ソースで確認した内容
- **本人方針**: 本人が今回の会話で定めた利用範囲
- **設計案**: 移行先として提案する構造。実装前であり変更可能

## WordPress

### 取得範囲

| サイト | 2026-08-31 REST監査 | 2026-07-10 WXR manifest | 制約 |
|---|---:|---:|---|
| kanolog.net | 認証済み。全readable status | あり | 既存Application Passwordが有効 |
| nocalog.net | 公開データのみ | あり | kanologの認証情報は401 |
| art-quiz.com | 公開データのみ | あり | kanologの認証情報は401 |

既存manifestにはWXR原本のSHA-256と件数が残っていますが、参照先XMLは現在存在しません。したがって、本文ブロック、全postmeta、非公開投稿、メニューを確定するには最新WXRの再取得が必要です。

### 件数

| サイト | 投稿 | 固定ページ | 添付 | Pochipp | 再利用ブロック | その他 |
|---|---:|---:|---:|---:|---:|---|
| kanolog.net REST | 1,371（公開1,370、下書き1） | 3 | 1,362 | 590（公開589、下書き1） | 3 | nav menu item 10 |
| nocalog.net 公開REST | 183 | 1 | 62 | 1 | API上は2、本文取得不可 | blog_parts 1 |
| art-quiz.com 公開REST | 291 | 0 | 603 | 13 | 0 | — |
| 2026-07-10 WXR合計 | 1,845 | 7 | 2,027 | 604 | 5 | blog_parts 1、nav menu item 13 |

WXR時点の投稿・固定ページ合計は1,852件です。2026-08-31の公開RESTでは更新後の差分があるため、WXR件数は本移行の確定値としては使いません。

kanolog.netでは認証RESTからコメント65件を確認しました。nocalog.net / art-quiz.comの公開RESTでは0件ですが、非承認・非公開コメントの不存在までは確認できていません。

添付は画像だけではありません。kanolog.netにはJPEG 815、PNG 481、GIF 54、WebP 6のほか、XLSX 3、PDF 1、MP3 1、SVG 1があります。nocalog.netにもPDFとXLSXがあります。したがってWordPress添付はEmDash media/fileとして扱い、公開写真アルバムへ一律に入れません。GIFアニメーション、SVG、音声、文書はパイロットで個別に表示確認します。

### WordPressの論理構造

1件の投稿系レコードは、最低限次を持ちます。

- `id`, `type`, `status`, `date`, `modified`, `slug`, `link`
- `title`, `content`, `excerpt`
- `author`, `parent`, `featured_media`, `template`, `format`
- taxonomy assignment（category、tag、カスタムtaxonomy）
- postmeta / RESTで登録された`meta`
- 添付、コメント、メニュー、再利用ブロックへの参照

kanolog.netの認証RESTで露出したmetaは `swell_btn_cv_data`、`footnotes`、`pochipp_data` でした。RESTは登録済みmetaしか返さないため、これを全postmeta一覧とは扱いません。

### 本文の変換リスク

kanolog.netのraw contentで、次のGutenbergブロックを確認しました。

- 主な標準ブロック: paragraph、image、list/list-item、quote、heading、separator、preformatted、embed、table、columns/column、html、code、audio、file、gallery、group
- プラグイン・テーマ依存: pochipp 989、loos 140、loos-hcb 23、jin-gb-block 17、jetpack 8、wpmf 1

また、Pochipp、`ays_quiz`、gallery、`itemlink`などのshortcode候補があります。監査の正規表現は文章中の角括弧も候補に含めるため、shortcode件数はWXRで構文確認してから確定します。

kanolog本文には少なくとも `kanolog.smugmug.com` 115参照、`photos.smugmug.com` 98参照がありました。これはURL出現回数で、ユニーク画像数ではありません。

## SmugMug

### 本人方針

- Google Photosにあるプライベート写真の代替はしない。
- SmugMugは公開サイト用であり、アルバム表示とブログ埋め込みが主用途。
- Gyazo代替は別Issueで検討し、今回の公開写真基盤へ混在させない。

### 公開API実測

| 項目 | 実測 |
|---|---:|
| 公開APIから読めるアルバム | 40 |
| 資産 | 2,168 |
| JPG | 2,156 |
| MP4 | 12 |
| API上の原本相当サイズ合計 | 6,465,591,357 bytes（約6.47 GB） |
| `ArchivedUri` + `ArchivedMD5`あり | 2,003 |
| `ArchivedUri`なし | 165 |
| ダウンロード許可アルバム | 36 |
| ダウンロード不許可アルバム | 4 |
| タイトルあり | 934 |
| キャプションあり | 687 |
| 動画 | 12 |
| 0以外の位置座標あり | 1,114 |
| hidden | 0 |

全40アルバムの`SecurityType`は公開API上 `None`、並び順は35件が撮影日、5件が手動positionです。39件は昇順、1件は降順です。

`Protected`はアルバム7件・資産339件でtrueですが、公開APIから読み取れることと、原本ダウンロード可否は別です。165資産は公開APIだけでは確実な原本取得経路が確認できず、所有者認証後の監査対象です。また1,114資産に0以外の位置座標があるため、移行時に値を保全しても新しい公開APIやHTMLへは既定で露出させません。

### SmugMugの論理構造

アルバムで確認した主な項目:

- 識別: `AlbumKey`, `NodeID`, `Uri`, `WebUri`, `UrlName`, `UrlPath`
- 表示: `Name`, `Title`, `Description`, `Keywords`, highlight/cover image
- 並び: `SortMethod`, `SortDirection`, `ImageCount`
- 公開・機能: `SecurityType`, `Protected`, `AllowDownloads`, `CanShare`, `CanBuy`, `CanFavorite`
- 関係: folder、parent folders、images、comments、share、download

画像・動画で確認した主な項目:

- 識別: `ImageKey`, `AlbumKey`, `Uri`, `WebUri`, `UploadKey`
- ファイル: `FileName`, `Format`, `OriginalSize`, `ArchivedSize`, `ArchivedUri`, `ArchivedMD5`
- 寸法・時刻: `OriginalWidth`, `OriginalHeight`, `DateTimeOriginal`, `DateTimeUploaded`
- 表示: `Title`, `Caption`, `Keywords`, `ThumbnailUrl`, size variants
- 状態: `Hidden`, `Protected`, `Watermarked`, `IsVideo`, `Status`
- 関係: album、comments、share、metadata、size details、video variants

## EmDash 0.35.0

配布パッケージの実装で次を確認しました。

- WordPressの直接REST importは未実装で、REST接続は検出用途。通常はWXR uploadを案内する。
- WXRは投稿、固定ページ、カスタム投稿タイプ、添付、taxonomy、メニュー、再利用ブロックを解析する。
- `post` → `posts`、`page` → `pages`、`attachment` → `media`が既定対応。未知のカスタム投稿タイプは同名collectionになる。
- 基本フィールドは `title:string`、`content:portableText`、`excerpt:text`。
- `_thumbnail_id`がある型には `featured_image:image`を追加する。
- `wp_block`はcollectionではなくsectionとして処理する。
- Gutenberg本文はPortable Textへ変換し、対応できないものは`htmlBlock`として保持できる。
- WXR statusはpublish/draft/pending/private/futureを認識する。ただしprivateの実際の公開制御はpilotで確認する。
- 添付URLをダウンロードしてEmDash storageへ取り込み、URLを書き換える経路を持つ。
- EmDash Exporter plugin経由のimportもあるが、WordPress側へのplugin導入が必要になる。

## 移行先の設計案

ブログと公開写真は同じR2を共有しても、論理モデルと公開経路を分けます。

```text
EmDash content (D1) ── media reference ──┐
                                        ├── media_asset (D1) ── object (R2)
Public album (D1) ── album_item ────────┘
```

- EmDash: posts、pages、必要なcustom collections、taxonomy、comments、redirects
- 公開写真: albums、album_items、media_assets、media_variants
- 共通台帳: source identities、source URLs、hash、R2 object key、import/verification status
- URL: `blog.kanouk.com`と`photos.kanouk.com`で明確に分ける
- private/Gyazo代替: 別バケット・別認証境界とし、今回の公開モデルには追加しない

## パイロット選定条件

最初の移行単位は次をすべて含む小さな集合にします。

- 1つのSmugMugアルバム（JPG、動画、タイトル/キャプション、撮影日順を含む）
- 5〜10本のブログ記事（WordPress添付、SmugMug直リンク、Gutenberg標準ブロックを含む）
- Pochippまたはテーマ依存ブロックを少なくとも1本含む
- 旧URLから新URLまでの対応を人手で全件照合できる規模
- 非公開写真やGyazo画像を含まない

パイロット合格条件は、件数一致、原本hash一致、本文中の画像参照ゼロ残存、PC/モバイル表示、旧URLの301、rollback手順の確認です。
