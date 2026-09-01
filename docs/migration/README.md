# EmDash / 公開写真基盤への移行

このディレクトリは [Issue #1](https://github.com/kanouk/kanouk.com/issues/1) の設計・監査・運用記録です。移行先は EmDash 0.35.0 + Astro + Cloudflare Workers / D1 / R2、公開名はブログが「カノログ」、デザインシステム名と独自ブロック名前空間は `Yohaku` です。

## 現在地（2026-09-01）

- Cloudflare Paid の `kanouk@gmail.com` 側に専用ステージングを構築済み。guard が account と resource 名を検査し、`fragrance.radio@gmail.com` 側への誤操作を止める
- staging Worker / D1 / R2 / KV を作成し、`kanouk-emdash-staging.kanouk.workers.dev` へデプロイ済み
- WordPress 3サイトのWXR原本、WXR添付2,027件とarchiveから回収した1件、合計2,028 mediaをR2へ移行・readback verified。1,854コンテンツは再importの2回目が全件`skipped_verified`
- kanolog は管理者RESTでも再監査し、公開1,370投稿、下書き1投稿、固定ページ3件、再利用ブロック3件、Pochipp 590件、コメント65件を確認
- nocalog / art-quiz は現在の公開REST件数がWXRの公開件数と一致。WXRには下書き・非公開も保持されている
- SmugMug は40アルバム、2,168アセット（JPEG 2,156、MP4 12）を固定ID付きmanifestへ収録。GPSを削除せず、1,932件をR2 readbackまでverified
- SmugMugの公開ダウンロードで原本MD5と一致しない236件は、縮小版で代用せず `pending_owner_auth` に分類。所有者OAuthのFull/Read認証器と、該当5アルバムだけを再開するfail-closed入口を用意済み
- コメント127件を公開65／保留62の状態を保って移行し、IPアドレスとUser-Agentは保存していない
- 全4 sitemap・3,820ページ・内部リンク5,843件を巡回し、HTTP/network失敗、`wordpress://`、旧WordPress upload、Gutenberg comment、shortcodeはいずれも0件。残るSmugMug 9参照はowner OAuth待ち236件に属する
- D1 SQLとR2全3,272 object（6,374,290,611 bytes）のbackup／別SQLite復元／全byte hash照合に成功
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

## ブログと写真サービスの境界

SmugMug代替は既製の別サービスではなく、このリポジトリで実装する公開写真閲覧システムです。ただしEmDash本体を写真サービス専用にforkしてはいません。

- 共通基盤: EmDash管理画面／Content API、D1、R2、認証、media管理
- ブログモデルとUI: Posts、Pages、Comments、Yohaku意味ブロック、記事／検索／taxonomy表示
- 写真モデルとUI: Albums、Public Photos、地図、EXIF、全画面、slideshow、共有、download policy
- 配信: 現在は1つのAstro／Worker内でhost別に分離し、将来必要なら写真frontだけ別Workerへ分離可能

つまり保存基盤と管理面は共通、データモデルと閲覧機能は用途別です。EmDashの公開extension pointだけを使い、アップグレード時は独自content type、Yohaku plugin、公開rendererの互換性テストを行います。

## 文書

- [source-schema.md](source-schema.md): 移行元・EmDashのデータ構造と実測件数
- [field-mapping.md](field-mapping.md): WordPress / SmugMugから移行先への対応
- [smugmug-feature-parity.md](smugmug-feature-parity.md): SmugMug閲覧機能の採否と実装状況
- [unmapped-fields.md](unmapped-fields.md): 未完了事項と最終ゲート
- [completion-audit.md](completion-audit.md): Issue #1〜#11の証拠ベース完了監査
- [operations-runbook.md](operations-runbook.md): deploy後監視、backup、復元、rollback、コスト測定

## 残っているゲート

1. SmugMug所有者OAuthをユーザー同席時に一度だけ認可し、`pending_owner_auth` 236件を原本一致へ収束させる。
2. その結果で1,854コンテンツを再importし、残るSmugMug 9参照を同時置換する。
3. 2,168件のmetadata、12 MP4、40 album cover／順序／件数を最終監査する。
4. 最終import後にbackup、全URL／SEO／desktop／mobile／dark mode監査を再実行する。
5. ここまで合格後もDNS切替は行わず、切替候補としてユーザーへ提示する。

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
