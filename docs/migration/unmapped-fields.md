# 未確定事項と移行ゲート

## 現在のblocker

| 項目 | 状態 | 次の操作 |
|---|---|---|
| Cloudflare account | Wrangler既定は `fragrance.radio@gmail.com` | `kanouk@gmail.com` の専用profileを作り、`whoami`で確認する。既定profileを誤用しない |
| 最新WXR | 2026-07-10 manifestはあるがXML原本なし | 3サイトから最新exportを取得し、SHA-256と件数を記録 |
| nocalog認証 | kanolog credentialでは401 | 専用Application PasswordまたはWXRを用意 |
| art-quiz認証 | kanolog credentialでは401 | 専用Application PasswordまたはWXRを用意 |
| SmugMug完全原本 | 2,003/2,168だけ公開APIにarchive URIあり | OAuth所有者認証で残り165を監査 |

## WordPressで未確定

- 全postmeta keyと値型。RESTで見える3 keyだけでは不足。
- Pochipp 604レコードのうち、記事から参照されるものと管理用データの境界。
- SWELL/JIN/Jetpack/WPMF/quiz blockの正確なrendering。
- `blog_parts` 1件をsectionへするかcollectionへするか。
- nav menu、widget、theme option、custom CSSのうち移行すべきもの。
- 下書き、非公開、予約投稿の総数（nocalog / art-quiz）。
- コメント本文と個人情報の公開方針。
- 2026-07-10以降の新規・更新・削除差分。
- 添付2,027件の原本存在、派生画像、`srcset`、hash、総容量。

## SmugMugで未確定

- `Protected`と公開範囲、download権限の組み合わせ。
- 原本URIなし165資産の取得可否。
- folder/parent folder階層を新UIに反映する必要性。
- 位置情報文字列が実座標か未設定sentinelか。公開には使用しない。
- EXIF、keywords、comments、share、purchase dataをどこまで保全するか。
- 12動画のcodec、poster、ブラウザ互換性。
- album highlightとnode coverが異なる場合の優先順位。

## EmDashでpilot確認が必要

- Pochipp、SWELL/JIN、quiz shortcodeがPortable Textまたは`htmlBlock`で表示可能か。
- `private` statusが公開route、preview、sitemapから確実に除外されるか。
- WXR media importerが3サイトの全attachment URLを取得できるか。
- 外部SmugMug直リンクをmedia importerへ渡すcustom transformの差し込み点。
- menu、comments、section、taxonomy階層の実データでの再現性。
- D1のwide collection制限と、不要なpostmetaを除外するallowlist。

## 判断済み

- プライベート写真の正本はGoogle Photosのまま。置き換えない。
- 今回の写真サービスは公開写真とブログ埋め込み専用。
- blogは `blog.kanouk.com`、photosは `photos.kanouk.com`。
- Gyazo代替は別Issue。公開R2 bucketや認証なしmedia URLへ混在させない。
- デザインの本格的なbrush-upはデータモデルとpilot成立後。最初は移行完全性とmobile基本UXを優先する。

## Phase 2開始時のチェック

```text
[ ] Cloudflare email = kanouk@gmail.com
[ ] account name / account idを作業ログに記録（secretとして公開Issueへ貼らない）
[ ] fragrance.radio@gmail.comではないことを二重確認
[ ] 最新WXR 3件のhashと件数を固定
[ ] SmugMug owner authのread-only疎通
[ ] pilot album / pilot postsを確定
[ ] D1/R2/Worker命名とrollback方針をレビュー
```
