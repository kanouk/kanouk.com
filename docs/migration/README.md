# EmDash / 公開写真基盤への移行

このディレクトリは [Issue #1](https://github.com/kanouk/kanouk.com/issues/1) の設計・監査・運用記録です。移行先は EmDash 0.35.0 + Astro + Cloudflare Workers / D1 / R2、公開名はブログが「カノログ」、デザインシステム名と独自ブロック名前空間は `Yohaku` です。

## 現在地（2026-09-01）

- Cloudflare Paid の `kanouk@gmail.com` 側に専用ステージングを構築済み。guard が account と resource 名を検査し、`fragrance.radio@gmail.com` 側への誤操作を止める
- staging Worker / D1 / R2 / KV を作成し、`kanouk-emdash-staging.kanouk.workers.dev` へデプロイ済み
- WordPress 3サイトのWXR原本、2,027添付、1,854コンテンツを台帳化。本文は17,050意味ブロックへ変換し、通常のフォールバック `htmlBlock` は0件
- kanolog は管理者RESTでも再監査し、公開1,370投稿、下書き1投稿、固定ページ3件、再利用ブロック3件、Pochipp 590件、コメント65件を確認
- nocalog / art-quiz は現在の公開REST件数がWXRの公開件数と一致。WXRには下書き・非公開も保持されている
- SmugMug は40アルバム、2,168アセット（JPEG 2,156、MP4 12）を固定ID付きmanifestへ収録。GPSを削除せず移行し、公開画像のR2転送を継続中
- SmugMugの公開ダウンロードで原本MD5と一致しない資産は、縮小版で代用せず `pending_owner_auth` に分類。所有者OAuthのFull/Read認証器を用意済み
- Yohakuのブログ／写真UI、ダークモード、検索、地図、EXIF、共有、全画面、スライドショー、キーボード／スワイプ移動をステージングへ実装済み
- DNS切替、WordPress停止、SmugMug解約は未実施。このIssue群ではユーザーの別途明示指示なしに実行しない

## データの流れ

```text
WordPress WXR / current REST ─┐
                              ├─ source audit ─ manifest/ledger ─ EmDash D1 + R2
SmugMug API / owner OAuth ────┘                                ├─ blog UI
                                                               └─ photos UI
```

移行器は中断・再実行可能です。取得時の原本ハッシュとCloudflareから読み戻したバイトを照合し、成功が確認できたものだけを `verified` にします。

## 文書

- [source-schema.md](source-schema.md): 移行元・EmDashのデータ構造と実測件数
- [field-mapping.md](field-mapping.md): WordPress / SmugMugから移行先への対応
- [smugmug-feature-parity.md](smugmug-feature-parity.md): SmugMug閲覧機能の採否と実装状況
- [unmapped-fields.md](unmapped-fields.md): 未完了事項と最終ゲート

## 残っているゲート

1. 進行中のSmugMug / WordPress media転送を完走し、全件を再実行して冪等性を確認する。
2. SmugMug所有者OAuthをユーザー同席時に一度だけ認可し、`pending_owner_auth` の原本を取得する。
3. verified media台帳を使って1,854コンテンツを再importし、WordPress / SmugMug旧URLを同時置換する。
4. コメントを移行し、件数・公開状態・個人情報の非公開を読み戻す。
5. D1 SQLと全R2 mediaをローカルへバックアップし、別SQLiteへの復元・hash照合を実証する。
6. 全URL / SEO / desktop / mobile / dark modeを監査する。
7. ここまで合格後もDNS切替は行わず、切替候補としてユーザーへ提示する。

## アカウントと秘密情報

- このプロジェクトのCloudflare: `kanouk@gmail.com`
- 香水ラジオ／香水ライブラリのCloudflare: `fragrance.radio@gmail.com`（現役だが、このリポジトリでは使用しない）
- API tokenやApplication PasswordはPrivate Vaultの `10_sensitive` にだけ保存し、Issue・Git・実行ログへ値を出さない
- import用の一時PATは移行完了後にrevokeする。それまでは削除しない

## 非対象

- Google Photosにある私的写真の代替
- Gyazo代替の半非公開アップロード基盤（Issue #2）
- 写真販売・プリント注文
- DNS切替、旧サービス停止・解約
