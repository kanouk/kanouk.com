# EmDash / 公開写真基盤への移行

このディレクトリは [Issue #1](https://github.com/kanouk/kanouk.com/issues/1) の設計・監査記録です。2026-08-31時点では、移行元を変更せずにデータ構造と機能を調べる Phase 1 を進めています。

## 現在地

- WordPress 3サイトとSmugMug公開APIの読み取り監査を実施した
- EmDash 0.35.0のWordPress importer実装を確認した
- 移行先の正規データモデルとフィールド対応案を作成した
- Cloudflare資源はまだ作成していない
- 現在のWrangler既定ログインは今回使用禁止の `fragrance.radio@gmail.com` である。Phase 2開始前に `kanouk@gmail.com` の専用プロファイルへ切り替えて再確認する

## 文書

- [source-schema.md](source-schema.md): 移行元・EmDashのデータ構造と実測件数
- [field-mapping.md](field-mapping.md): WordPress / SmugMugから移行先への対応
- [smugmug-feature-parity.md](smugmug-feature-parity.md): SmugMug機能の残す・置き換える・捨てる判定
- [unmapped-fields.md](unmapped-fields.md): 未確定事項、欠損、次工程のゲート

## Phase 2へ進む条件

1. `kanouk@gmail.com` でWranglerへログインし、対象アカウントを `wrangler whoami` で確認する。
2. 3サイトから最新WXRを再取得し、SHA-256付きで保全する。
3. nocalog.net / art-quiz.comの下書き・非公開コンテンツを含む完全な取得手段を用意する。
4. SmugMugの所有者認証を用意し、公開APIから原本を取得できない165資産を確認する。
5. 正規モデルの必須項目と旧URL保持規則をレビューする。

これらが揃うまでは、本番D1/R2作成、DNS変更、WordPress/SmugMugへの書き込みを行いません。
