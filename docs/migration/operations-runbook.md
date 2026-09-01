# Yohaku運用・監視・バックアップrunbook

対象は `blog.kanouk.com` / `photos.kanouk.com` と、切替前の統合ステージングです。DNS切替、旧WordPress停止、SmugMug解約はこのrunbookを実行するだけでは行いません。

## 毎回のdeploy後

```sh
cd /Users/kanouk/projects/kanouk.com/apps/web
npm run typecheck
npm run build
npm run deploy

cd /Users/kanouk/projects/kanouk.com
python3 scripts/migration/verify_public_site.py
```

`verify_public_site.py` は次をread-onlyで検査します。

同じテスト列はGitHub Actionsの`Verify Yohaku`でも直列実行します。認証情報の保存先を増やさないため、CIはbuildとstaging readbackまでに限定し、deploy・D1 migration・rollbackはPrivate Vault credentialを使うローカルguard経路のままです。

1. カノログtopが200で読める。
2. 記事一覧が200で読める。
3. アルバム一覧が200で読める。
4. 写真検索が200で結果画面を返す。
5. 存在しないURLが404を返す。
6. sitemap indexがblog / photos両方のsitemapを持つ。
7. 実在するR2 mediaが画像として読み戻せる。
8. stagingは`X-Robots-Tag: noindex`を返す。
9. `nosniff`とReferrer-Policyがある。

custom domain接続後はhostごとに実行します。

```sh
python3 scripts/migration/verify_public_site.py \
  --base-url https://blog.kanouk.com \
  --no-expect-preview-noindex

python3 scripts/migration/verify_public_site.py \
  --base-url https://photos.kanouk.com \
  --no-expect-preview-noindex
```

host分離後は、汎用monitorに加えてblog hostへphoto route、photos hostへblog routeを送ったときの308とLocationも確認します。

## 切替後の監視時点

| 時点 | 必須確認 |
|---|---|
| 切替直後 | health check、代表記事・album・photo・media、DNS、TLS、canonical、robots、sitemap、rollback可否 |
| 1時間 | Worker 5xx、404、R2 media error、GA4 realtime、旧URLへの流入 |
| 24時間 | Search Console受信、sitemap取得、主要landing page、mobile、dark mode |
| 1週間 | 404上位、検索流入、外部参照、Core Web Vitals、Cloudflare usage |
| 1か月 | index coverage、GA4比較、実費、backup/restore再実行、旧環境依存 |
| 3か月 | 旧URL残存、コスト、運用品質をまとめ、旧サービスを残す／解約候補にする判断材料を提示 |

検索エンジン側の処理待ちは即時合格とせず、pendingとして次の監視時点へ持ち越します。

## Cloudflare staging backup

最終import後、Privateの外部原本領域へD1 SQLと全media byteを保存します。

```sh
cd /Users/kanouk/projects/kanouk.com

# 件数と総byteのdry-run
python3 scripts/migration/backup_cloudflare_staging.py

# D1 export + 全media download + hash台帳
python3 scripts/migration/backup_cloudflare_staging.py --apply --concurrency 4

# 上の出力に表示されたbackup directoryを指定
python3 scripts/migration/verify_cloudflare_backup.py \
  /Users/kanouk/Documents/Private_External_Imports/kanouk-cloudflare-backups/<timestamp>
```

backupは次を満たした場合だけ成功です。

- D1 SQLのSHA-256とbyte数がmanifestに一致。
- 全mediaのSHA-256とbyte数がmanifestに一致。
- media合計byteがmanifestと一致。
- D1 SQLを一時SQLiteへ流し込める。
- `PRAGMA integrity_check`が`ok`。
- 復元後のtable数が0ではない。

WXR、SmugMug manifest、WordPress media ledger、旧新URL ledgerはR2 backupとは別に保存します。credential、PAT、Application Passwordはbackupへ混ぜません。

## rollbackの境界

- Worker codeは直前のCloudflare versionへ戻せる。
- DNS切替前なら旧WordPress / SmugMugがそのまま公開正本なので、切替操作をしなければrollbackは不要。
- DNS切替後も旧WordPress / SmugMugを読み取り可能なまま残す。
- Worker rollbackはD1 / R2の内容を戻さない。data変更があるreleaseは、変更前D1 exportとR2 inventoryを必須にする。
- D1 migration、content import、media import、deployを同時に走らせず、各readback合格後に次へ進む。
- PATは全importと最終readbackが終わるまでrevokeしない。

## コストの測り方

価格は実行時に公式ページを再確認します。

- Workers Paid: account最低月額とrequest / CPUの実使用
- R2: GB-month、Class A、Class B。public egressは無料
- D1: rows read / rows written / storage
- Imagesを使っていなければ0として分離し、R2をImages料金へ二重計上しない

公式価格:

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/

2026-09-01時点の概算では、Workers Paidの最低額が月$5なら年$60です。SmugMug年$100だけとの単純比較は年約$40削減ですが、最終R2総量、request実績、WordPress hosting費を含めた実測後に確定します。無料枠に収まるという仮定で完了扱いにはしません。

## 解約判断

次が揃っても自動解約しません。

- 全asset / media / contentの最終状態が説明可能。
- 旧URL対応とSEO監視が一定期間安定。
- backupとrestore drillが成功。
- 実費と削減額が説明可能。

条件が揃った時点で「解約可能性がある」と報告し、実際のSmugMug／WordPress停止・削除・解約はユーザーの別途明示指示を待ちます。
