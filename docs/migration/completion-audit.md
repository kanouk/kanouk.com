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
| #1 統合移行 | 部分達成 | Cloudflare基盤、WordPress全件、写真2,168件、Yohaku、全公開crawl、backup/restoreが成立 | 認証後のDNS切替、custom domain readback、切替後監視 |
| #2 Gyazo代替 | 対象外 | 公開写真移行とはデータ境界・認証要件が異なる別Issue | 今回は実装しない |
| #3 データ構造監査 | 達成 | `source-schema.md`、`field-mapping.md`、WXR/SmugMug catalog実測 | なし。最終値だけ台帳から更新する |
| #4 Cloudflare基盤 | 達成 | `kanouk@gmail.com` account guard、Worker/D1/R2/KV、公開readback、`kanouk.com` zone作成 | custom domainの公開切替は#10 |
| #5 写真パイロット | 達成 | 固定ID、GPS保持、R2 roundtrip、写真・動画・地図・UIの実証 | なし |
| #6 Yohakuデザイン | 部分達成 | 共通token/component、blog/photos UI、dark mode、320/390/1440px、基準線、画像比率、キーボード、contrast、SEO回帰を最終データで確認 | custom domainでのPC/mobile/dark readback |
| #7 意味ブロック | 達成 | 1,854件/17,055 block、`htmlBlock` 0、9種類の編集UI/renderer、公開crawlのshortcode/Gutenberg comment 0 | なし |
| #8 SmugMug完全移行 | 達成 | 40 album/2,168 assetすべてverified、重複ID/manifest不一致/pending 0、GPS/EXIF保持、metadata backfill済み | なし |
| #9 WordPress完全移行 | 達成 | 2,028 media verified、1,854 content再実行`skipped_verified`、comments 127、旧WP/SmugMug/shortcode/Gutenberg comment 0 | nocalog/art-quizのWXR後非公開差分は管理認証外のためunknownとして記録済み |
| #10 URL/SEO/切替 | 部分達成 | 4 sitemap、4,056 page、6,302 internal link、HTTP/network/旧参照0。canonical/robots/OGP/JSON-LD/readback合格。DNS承認済み | registrar認証、nameserver切替、Custom Domain deploy、本番readback |
| #11 監視/backup/実費 | 部分達成 | D1 SQLとR2 3,507 object/6,933,980,178 bytesを保全し、別SQLite復元、40,974 row、integrity/foreign key、全media hashを検証 | custom domain切替後監視、Cloudflare請求期間後の実費確定。解約はしない |

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

- ムームードメイン管理画面の認証
- Cloudflare指定nameserverへの切替とzone active化
- custom domainのTLS発行・DNS伝播
- Search Console／GA4の外部処理と、1週間・1か月・3か月の経時監視

## 完了を宣言しない理由

データ移行、ステージング全件監査、最終backup/restoreは完了し、機械ゲートは`cutover_ready: true`です。ただし独自ドメインがまだ公開トラフィックを処理しておらず、切替後監視と実請求期間も未経過です。したがってIssue #1/#6/#10/#11は、本番readbackと経時監視の証拠が揃うまで完了を宣言しません。
