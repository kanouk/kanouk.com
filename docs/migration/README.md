# EmDash / 公開写真基盤への移行

このディレクトリは [Issue #1](https://github.com/kanouk/kanouk.com/issues/1) の設計・監査・運用記録です。移行先は EmDash 0.35.0 + Astro + Cloudflare Workers / D1 / R2、公開名はブログが「カノログ」、デザインシステム名と独自ブロック名前空間は `Yohaku` です。

## 現在地（2026-09-02）

- Cloudflare Paid の `kanouk@gmail.com` 側に専用ステージングを構築済み。guard が account と resource 名を検査し、`fragrance.radio@gmail.com` 側への誤操作を止める
- staging Worker / D1 / R2 / KV を作成し、`kanouk-emdash-staging.kanouk.workers.dev` へデプロイ済み
- WordPress 3サイトのWXR原本、WXR添付2,027件とarchiveから回収した1件、合計2,028 mediaをR2へ移行・readback verified。1,854コンテンツは再importの2回目が全件`skipped_verified`
- kanolog は管理者RESTでも再監査し、公開1,370投稿、下書き1投稿、固定ページ3件、再利用ブロック3件、Pochipp 590件、コメント65件を確認
- nocalog / art-quiz は現在の公開REST件数がWXRの公開件数と一致。WXRには下書き・非公開も保持されている
- SmugMug は40アルバム、2,168アセット（JPEG 2,156、MP4 12）を固定ID付きmanifestへ収録。所有者OAuthで原本を回収し、GPSを削除せず2,168件すべてをR2 readbackまでverified
- コメント127件を公開65／保留62の状態を保って移行し、IPアドレスとUser-Agentは保存していない
- staging全4 sitemap・4,056ページ・内部リンク6,302件と、切替後のhost別4 sitemap・4,056ページ・内部リンク6,490件を巡回。残存参照はいずれも0件で、本番の一時timeout 4件も対象再監査12/12で200
- D1 SQLとR2全3,546 object（6,978,619,128 bytes）のbackup／別SQLite復元／全byte hash照合に成功。85 table／40,273 row、integrity `ok`、foreign key違反0。うち3,507件はEmDash media、39件（44,638,950 bytes）は現行media tableから参照されないR2 objectとして削除せず保全
- Yohakuのブログ／写真UI、ダークモード、検索、地図、EXIF、共有、全画面、スライドショー、キーボード／スワイプ移動をステージングへ実装済み
- production実画面で商品カード画像、クイズ回答、写真前後移動、dark modeを再確認。古い記事の月選択不整合を全期間対応へ修正済み
- Gutenberg引用271コンテンツ／370ブロックを`yohaku.quote`へ再変換し、欠落本文0をD1で確認。長文・複数段落・箇条書き引用を390／1440pxとlight／darkで再確認済み
- `kanouk.com`を`kanouk@gmail.com`側Cloudflareへ追加し、2026-09-02にnameserver切替、zone active、2 Custom Domain、TLS、本番readbackまで完了
- 旧カノログのGA4 `G-94EQ0WN7B9`をproduction 2ホストだけへ継承。stagingはanalyticsなし・`noindex`のまま維持
- Workers CPUは9月account-wide 4,163,572.355 ms、切替後Yohaku 422,358.830 msをread-onlyで観測。月30,000,000 ms枠内だが、GraphQLの適応サンプリング推定なので確定請求とは分離
- Cloudflare Billingの初回read-only確認では従量課金$0.00、9月1日の支払済み請求$5.50。同額が毎月続く場合は年$66／SmugMugとの差年$34だが、単一請求からの暫定値
- Search Consoleは`kanouk@gmail.com`のログイン済み画面でも`sc-domain:kanouk.com`へのアクセス拒否を確認。所有権証明とsitemap送信は実行せず、明示承認待ち
- GA4 Realtime APIで対象stream `2210574206`（カノログ）の1 view／1 active userを確認。RealtimeはhostName非対応のため、host別確定は標準report待ち
- WordPress停止、SmugMug解約は未実施し、今回も対象外とする

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
- [cloudflare-billing-snapshot-2026-09-02.json](cloudflare-billing-snapshot-2026-09-02.json): 機微情報を除いた初回請求・従量課金snapshot
- [search-console-access-2026-09-02.json](search-console-access-2026-09-02.json): 対象propertyのread-onlyアクセス確認結果
- `scripts/migration/monitor_production.py`: 時刻ゲート付きの本番監視JSON（Cloudflare、公開readback、404）

## 完了後の任意運用事項

1. 自動の経時監視スケジュールは、価値が限定的という2026-09-02のユーザー判断により削除済み。実行器は残し、障害調査や費用再測定が必要な場合だけ手動で使う。
2. Search Console所有権証明とsitemap送信は外部権限・設定の変更を伴うため、移行実装とは分離し、実行時に明示承認を得る。
3. 初回請求$5.50と現時点の従量課金$0.00は確認済み。同額が続く場合は年$66、SmugMugとの差は年$34という暫定値であり、確定値が必要なら請求期間実績を再測定する。
4. 旧WordPress／SmugMugは停止・解約せず、別途判断する。

## アカウントと秘密情報

- このプロジェクトのCloudflare: `kanouk@gmail.com`
- 香水ラジオ／香水ライブラリのCloudflare: `fragrance.radio@gmail.com`（現役だが、このリポジトリでは使用しない）
- API tokenやApplication PasswordはPrivate Vaultの `10_sensitive` にだけ保存し、Issue・Git・実行ログへ値を出さない
- import用の一時PATは移行完了後にrevokeする。それまでは削除しない

## 非対象

- Google Photosにある私的写真の代替
- Gyazo代替の半非公開アップロード基盤（Issue #2）
- 写真販売・プリント注文
- 旧サービス停止・解約
