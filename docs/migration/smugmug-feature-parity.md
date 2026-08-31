# SmugMug機能の精査

SmugMug全機能を再実装するのではなく、現在の使い方に必要な公開アルバム・ブログ埋め込みを移します。

## 必須（初回リリース）

| 機能 | 根拠 | 移行先 |
|---|---|---|
| アルバム一覧・詳細 | 公開サイトとして使用 | photos frontend + D1 |
| カバー画像 | SmugMugにhighlight/cover関係あり | `album.cover_media_id` |
| 撮影日順・手動順・昇降順 | 35/5、39/1で実利用 | `sort_method`, `position`, `sort_direction` |
| 写真/動画表示 | JPG 2,156、MP4 12 | R2 + responsive frontend |
| タイトル・キャプション | 934 / 687資産で使用 | media/album item fields |
| 前後移動・lightbox | アルバム閲覧の基本 | photos frontend |
| ブログ埋め込み | 本文にSmugMug host参照あり | EmDash media nodeへ変換 |
| レスポンシブ画像 | 表示速度・mobile UX | R2 variants + `srcset` |
| ダウンロード可否 | 36許可、4不許可 | album policyとして保持 |
| 安定URL | 旧リンク置換と再監査に必要 | source identity + URL ledger |
| 動画poster/再生 | 12 MP4 | variant + HTML video |
| SEO metadata | 公開サイト | title、description、OG、canonical、sitemap |

## 置き換える機能

| SmugMug | 置き換え |
|---|---|
| SmugMug image size URLs | R2派生画像 |
| SmugMug share URL | photos.kanouk.comのcanonical URL |
| SmugMug album download | 許可アルバムのみWorker経由、または初回は個別原本download |
| SmugMug navigation/site skin | kanouk.com共通の軽量navigation |
| API上のMD5 | 取得確認に使い、R2台帳はSHA-256も保持 |

## 初回リリースでは作らない

- 写真プリント・販売・price list・package
- favorite
- Lightroom等との同期
- watermark編集
- 顧客納品gallery
- SmugMug同等のサイトビルダー
- private/unlisted album
- Gyazo型のupload shortcut、guess-resistant URL、password/API allowlist

最後の2項目はセキュリティ境界が異なるためIssue #2で扱います。

## 確認が必要

- 7 protected album / 339 protected assetの実際の意味と所有者画面上の設定
- ダウンロード不許可4アルバムを新サイトでも不許可にするか
- 位置情報・EXIFを公開表示するか（既定は非公開）
- コメント、共有、購入機能に残すべき実データがあるか
- folder階層をUIへ残すか、album一覧へ平坦化するか
- 165資産の所有者認証による原本取得方法

## 受け入れ確認

パイロットでは、同じアルバムをSmugMugと新サイトで横に並べて次を確認します。

1. 件数、並び順、カバーが一致する。
2. JPGとMP4が表示・再生できる。
3. タイトル、キャプション、縦横比が保たれる。
4. mobileでlightboxと前後移動が使える。
5. ダウンロード不許可をUIが破らない。
6. ブログ埋め込みからSmugMug host参照が消える。
7. 原本hashまたはsource MD5が一致する。
