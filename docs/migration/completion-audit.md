# Issue #1〜#11 完了監査

更新日: 2026-09-02

この文書は、Issue本文のチェック状態ではなく、manifest、移行台帳、公開readback、backup検証結果を正本として、移行全体の達成・未達を判定します。DNS切替はユーザーから明示承認済みです。旧WordPress停止、SmugMug解約、データ削除は対象外です。

## 判定の原則

- `達成`: 現在の実データ、公開readback、または復元試験が要件を直接証明している。
- `部分達成`: 実装は成立しているが、最終データまたはcustom domainでの再検証が残る。
- `外部ゲート`: ユーザー認証、DNS切替後の時間経過、請求期間など、現在のステージングだけでは確定できない。
- `対象外`: 親Issueから明示的に分離した作業、または解約・削除。

## Issue別の現在地

| Issue | 判定 | 現在の直接証拠 | 真正の残作業 |
|---|---|---|---|
| #1 統合移行 | 部分達成 | Cloudflare基盤、WordPress全件、写真2,168件、Yohaku、独自ドメイン公開、全公開crawl、backup/restoreが成立 | 切替後の経時監視 |
| #2 Gyazo代替 | 対象外 | 公開写真移行とはデータ境界・認証要件が異なる別Issue | 今回は実装しない |
| #3 データ構造監査 | 達成 | `source-schema.md`、`field-mapping.md`、WXR/SmugMug catalog実測 | なし。最終値だけ台帳から更新する |
| #4 Cloudflare基盤 | 達成 | `kanouk@gmail.com` account guard、Worker/D1/R2/KV、公開readback、`kanouk.com` zone作成 | custom domainの公開切替は#10 |
| #5 写真パイロット | 達成 | 固定ID、GPS保持、R2 roundtrip、写真・動画・地図・UIの実証 | なし |
| #6 Yohakuデザイン | 達成 | 共通token/component、blog/photos UI、dark mode、320/390/1440px、単一記事軸、画像比率、キーボード、contrast、Lighthouse中央値、独自ドメインの同一Worker readbackを最終データで確認 | なし。今後の意匠調整は移行完了条件と分離する |
| #7 意味ブロック | 達成 | 1,854件/17,055 block、`htmlBlock` 0、9種類の編集UI/renderer、公開crawlのshortcode/Gutenberg comment 0 | なし |
| #8 SmugMug完全移行 | 達成 | 40 album/2,168 assetすべてverified、重複ID/manifest不一致/pending 0、GPS/EXIF保持、metadata backfill済み | なし |
| #9 WordPress完全移行 | 達成 | 2,028 media verified、1,854 content再実行`skipped_verified`、comments 127、旧WP/SmugMug/shortcode/Gutenberg comment 0 | nocalog/art-quizのWXR後非公開差分は管理認証外のためunknownとして記録済み |
| #10 URL/SEO/切替 | 達成 | nameserver切替、zone active、2 Custom Domain、TLS、host分離308、canonical/robots/OGP/JSON-LD、代表readback 26/26が合格。本番4,056 page・6,490 internal linkを再監査し、残存参照0。一時timeout 4件は対象再監査12/12で200 | なし。Search Consoleの反映は非同期監視として#11で扱う |
| #11 監視/backup/実費 | 部分達成 | D1 SQLとR2 3,507 object/6,933,980,178 bytesを保全し、別SQLite復元、40,974 row、integrity/foreign key、全media hashを検証。切替約1時間後もzone/domain/readback正常、active deployment error rate 0%、asset 5xx 0 | 24時間以降の経時監視、Search Console／GA4外部反映、Cloudflare請求期間後の実費確定。解約はしない |

## 2026-09-02 Yohaku staging QA

- 記事の上部メタ、タイトル、カバー画像、本文は、1280px viewportで左`176.5px`・幅`624px`、390px viewportで左`19.5px`・幅`336px`へ一致。重複していた左メタ欄はDOMから撤去し、横overflowは0。
- mobile Lighthouse 3回の中央値: 記事 Performance 96、Accessibility 100、Best Practices 100、LCP 1.615秒、CLS 0.00595、TBT 0ms。
- mobile Lighthouse 2回の中央値: アルバム一覧 Performance 96.5、Accessibility 100、Best Practices 100、LCP 2.481秒、CLS 0.00165、TBT 0ms。
- stagingは意図的に`noindex`のため、Lighthouse SEO categoryの点数は本番SEO判定に使わない。canonical、robots、OGP、JSON-LD、sitemapは`verify_public_site.py`と全sitemap crawlで別検証済み。
- `preview-v1`は1200×900 WebPの実readbackで204,708 bytes、`cf-resized: internal=ok`、1年immutable cacheを確認。低解像度原本は変形せず、1条件だけを共通componentから利用する。
- Python 125件、WordPress変換25件、Astro typecheck 0 error/warning/hint、production build、staging公開readback 14/14が合格。

## 2026-09-02 production cutover

- ムームードメインのnameserverを`desi.ns.cloudflare.com` / `harlan.ns.cloudflare.com`へ変更し、.com親DNS、1.1.1.1、8.8.8.8、9.9.9.9で新委任を確認。Cloudflare zoneは06:53:55 JSTに`active`を確認した。
- `kanouk@gmail.com`専用guardを通して2 Custom Domainを適用。Cloudflare APIで`blog.kanouk.com` / `photos.kanouk.com`がともに`kanouk-emdash-staging`のproduction environmentへ接続されていることを確認した。
- TLSは`CN=kanouk.com`、SAN=`kanouk.com` / `*.kanouk.com`、issuer=`Google Trust Services WE1`。両ホストでHTTPS 200を確認した。
- `blog`代表readback 14/14、`photos`代表readback 12/12、相互のroute分離308、host別sitemap、robots、canonical、JSON-LD、OGP、実media、404が合格した。
- 本番全件crawlはblog 1,848 page / 2,278 internal link、photos 2,208 page / 4,212 internal link。WordPress pseudo URL、uploads、SmugMug、旧site link、Gutenberg comment、legacy shortcodeはすべて0件だった。
- 全件crawl中の一時network timeoutはblog 1件、photos 3件。対象URLを同じ内容検査で各3回再監査し、12/12でHTTP 200。本文対象はtitleあり・残存参照0だった。
- apex `kanouk.com`は200、`www.kanouk.com`はapexへの301を維持した。旧WordPress / SmugMugは停止・解約・削除していない。
- 旧カノログと同じGA4 measurement ID `G-94EQ0WN7B9`をproduction 2ホストだけへ復元した。Worker version `86d6efcb-7a33-48db-85be-d7f66c29fe7b`のHTMLで両ホストのtagを読み戻し、stagingではtagなし・`noindex`を維持した。GA4 realtimeの外部反映はpendingとして扱う。
- 切替約1時間後にzone active、Custom Domain 2件、代表readback 26/26、active deployment error rate 0%、asset 5xx 0を再確認した。GA4欠落はこの時点で発見し、上記versionで是正した。
- 機械可読の要約は`production-cutover-2026-09-02.json`を参照する。

## 機械監査

通常実行は状態をJSONで表示し、未完了でも終了コード0にします。

```bash
python3 scripts/migration/audit_migration_completion.py \
  --backup-manifest /path/to/backup/manifest.json \
  --backup-verification /path/to/backup-verification.json \
  --public-audit /path/to/final-public-audit.json \
  --dns-change-authorized
```

切替前ゲートでは`--require-complete`を付けます。1件でも未完了なら終了コード2です。

```bash
python3 scripts/migration/audit_migration_completion.py --require-complete
```

backup manifestの存在確認だけでは復元成功を意味しません。復元と全byte照合は別コマンドで実証します。

```bash
python3 scripts/migration/verify_cloudflare_backup.py \
  /path/to/backup \
  --output /path/to/backup-verification.json
```

2026-09-02の最終復元結果:

```json
{
  "verified": true,
  "media_count": 3507,
  "media_total_bytes": 6933980178,
  "d1_tables_restored": 85,
  "d1_rows_restored": 40974,
  "d1_integrity": "ok",
  "d1_foreign_key_violations": 0
}
```

## 現在の外部ゲート

- Search Console／GA4の外部反映と、24時間・1週間・1か月・3か月の経時監視

## 完了を宣言しない理由

データ移行、最終backup/restore、独自ドメイン切替、本番代表readback、本番全件監査、切替約1時間後の初回監視は完了しました。Issue #6/#10は達成、#1/#11は24時間以降の経時監視と実請求期間が未経過のため部分達成です。旧WordPress / SmugMugの停止・解約は別判断のままです。
