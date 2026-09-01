# Issue #1〜#11 完了監査

更新日: 2026-09-01

この文書は、Issue本文のチェック状態ではなく、manifest、移行台帳、公開readback、backup検証結果を正本として、移行全体の達成・未達を判定します。DNS切替、旧WordPress停止、SmugMug解約、データ削除はユーザーの別途明示指示なしに実行しません。

## 判定の原則

- `達成`: 現在の実データ、公開readback、または復元試験が要件を直接証明している。
- `部分達成`: 実装は成立しているが、最終データまたはcustom domainでの再検証が残る。
- `外部ゲート`: ユーザー認証、DNS切替後の時間経過、請求期間など、現在のステージングだけでは確定できない。
- `対象外`: 親Issueから明示的に分離した作業、または解約・削除。

## Issue別の現在地

| Issue | 判定 | 現在の直接証拠 | 真正の残作業 |
|---|---|---|---|
| #1 統合移行 | 部分達成 | Cloudflare基盤、WordPress全件、写真1,932件、Yohaku、全公開crawl、backup/restoreが成立 | #8の236件、最終再import・再監査、承認後のDNS切替、切替後監視 |
| #2 Gyazo代替 | 対象外 | 公開写真移行とはデータ境界・認証要件が異なる別Issue | 今回は実装しない |
| #3 データ構造監査 | 達成 | `source-schema.md`、`field-mapping.md`、WXR/SmugMug catalog実測 | なし。最終値だけ台帳から更新する |
| #4 Cloudflare基盤 | 達成 | `kanouk@gmail.com` account guard、staging Worker/D1/R2/KV、公開readback | production custom domainは#10の承認ゲート |
| #5 写真パイロット | 達成 | 固定ID、GPS保持、R2 roundtrip、写真・動画・地図・UIの実証 | なし |
| #6 Yohakuデザイン | 部分達成 | 共通token/component、blog/photos UI、dark mode、320/390px、キーボード、contrast、SEO回帰をstagingで確認 | 最終データ後の代表再確認と、承認されたcustom domainでのPC/mobile readback |
| #7 意味ブロック | 部分達成 | 1,854件/17,050 block、`htmlBlock` 0、9種類の編集UI/renderer、管理画面で`yohaku.steps`を編集・破棄・再読込、公開crawlのshortcode/Gutenberg comment 0 | owner OAuth後の最終再importと代表記事の最終比較 |
| #8 SmugMug完全移行 | 未達 | 40 album/2,168 assetをmanifest化、1,932 verified、重複ID/manifest不一致0 | Full/Read owner OAuthで5 album/236 assetを原本取得しverifiedへ収束 |
| #9 WordPress完全移行 | 部分達成 | 2,028 media verified、1,854 content再実行`skipped_verified`、comments 127、旧WP upload/shortcode/Gutenberg comment 0 | SmugMug 9参照の置換。nocalog/art-quiz非公開の現在差分はWXR以降unknown。ホスト全体backupは管理アクセス範囲外 |
| #10 URL/SEO/切替 | 部分達成 | 4 sitemap、3,820 page、5,843 internal link、HTTP/network/旧WP参照0。canonical/robots/OGP/JSON-LD/readback合格 | owner OAuth後の最終crawl・backup。DNSは操作内容を提示し、別途明示承認後のみ実施 |
| #11 監視/backup/実費 | 部分達成 | D1 SQLとR2 3,272 object/6,374,290,611 bytesを保全し、別SQLite復元、36,746 row、integrity/foreign key、全media hashを検証 | 最終import後backup、custom domain切替後監視、Cloudflare請求期間後の実費確定。解約はしない |

## 機械監査

通常実行は状態をJSONで表示し、未完了でも終了コード0にします。

```bash
python3 scripts/migration/audit_migration_completion.py \
  --backup-manifest /path/to/backup/manifest.json \
  --backup-verification /path/to/backup-verification.json \
  --public-audit /path/to/final-public-audit.json
```

切替前ゲートでは`--require-complete`を付けます。1件でも未完了なら終了コード2です。

```bash
python3 scripts/migration/audit_migration_completion.py --require-complete
```

backup manifestの存在確認だけでは復元成功を意味しません。復元と全byte照合は別コマンドで実証します。

```bash
python3 scripts/migration/verify_cloudflare_backup.py \
  /path/to/backup | tee /path/to/backup-verification.json
```

2026-09-01の復元結果:

```json
{
  "verified": true,
  "media_count": 3272,
  "media_total_bytes": 6374290611,
  "d1_tables_restored": 85,
  "d1_rows_restored": 36746,
  "d1_integrity": "ok",
  "d1_foreign_key_violations": 0
}
```

## 現在の停止条件

`pending_owner_auth` 236件を公開縮小画像で代用しません。対象は次の5アルバムに限定されています。

| album | source key | pending |
|---|---|---:|
| `stream` | `8w6v9r` | 71 |
| `2005-05-kumamoto` | `Bb7gWn` | 23 |
| `2023-01-nara-kyoto` | `R8jnsN` | 73 |
| `2005-03-expo` | `Vhmwwv` | 13 |
| `2025-02-kyoto` | `f69Tqb` | 56 |

この認証後は、該当5アルバムだけを再開し、metadata backfill、1,854件再import、全公開crawl、最終backupを順番に実行します。同じD1/R2へ並行書込みせず、各readback合格後に次へ進みます。

## 完了を宣言しない理由

現時点のWordPress移行とYohaku実装は成立していますが、写真236件が原本未照合であり、そのうち2025-02京都の9参照が記事内に残ります。したがって「全データ移行完了」「切替可能」「年間削減額確定」はまだ証明されていません。owner OAuth後の最終監査と、別途承認された場合のcustom domain切替・監視までをIssue #1の完了判定に含めます。
