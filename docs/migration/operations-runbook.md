# Yohaku運用・監視・バックアップrunbook

対象は `blog.kanouk.com` / `photos.kanouk.com` と、統合ステージングです。DNS切替はユーザーから明示承認済みです。旧WordPress停止、SmugMug解約はこのrunbookの対象外です。

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
6. sitemap indexが、blogではposts/pages、photosではalbums/photosだけを持つ。
7. 実在するR2 mediaが画像として読み戻せる。
8. stagingは`X-Robots-Tag: noindex`を返す。
9. `nosniff`とReferrer-Policyがある。

### 公開画像previewの固定契約

一覧、アルバム詳細、記事内画像は、低解像度原本を除き
`/_yohaku/media/preview-v1/<storage-key>`を通します。`preview-v1`の契約は
`幅1200px / WebP / quality 85 / scale-down`の1種類だけです。`scale-down`なので
原本より大きく引き伸ばしません。変形に失敗した場合は原本へ安全にfallbackします。

URLのversionと変形条件は、見た目だけでなくCloudflare Imagesのunique
transformation数とブラウザのimmutable cacheを管理する契約です。幅違いの`srcset`や
別formatを安易に増やさず、変更時は新version、対象media数、当月usage、旧cacheの影響を
先に監査します。現行R2 mediaは3,507件なので、各原本をこの1条件で一度ずつ変形する
前提ではImages Freeの月5,000 unique transformations内ですが、実usageとerror 9422を
Cloudflare dashboardで監視し、無料枠内と推測だけで確定しません。

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

## 2026-09-02 DNS切替

Cloudflare accountは`kanouk@gmail.com`、zoneは`kanouk.com`です。`fragrance.radio@gmail.com`側を使用しません。

切替前の公開DNS:

- nameserver: `dns01.muumuu-domain.com` / `dns02.muumuu-domain.com`
- apex A: GitHub Pagesの4 address
- `www`: `kanouk.github.io`
- MX / TXT / CAA: なし
- `blog` / `photos`: なし

Cloudflare指定nameserver:

- `desi.ns.cloudflare.com`
- `harlan.ns.cloudflare.com`

手順:

1. ムームードメイン管理画面でrecord一覧とDNSSEC無効を確認する。
2. Cloudflare側のapex A 4件と`www` CNAMEが現行値と一致することを確認する。
3. registrarのnameserverをCloudflare指定2件へ置換する。
4. `dig NS kanouk.com`とCloudflare dashboardでzone activeを確認する。
5. `wrangler.jsonc`の2 Custom Domainをguard付きdeployし、CloudflareがDNS recordとTLS certificateを発行したことを確認する。
6. blog / photosのreadback、host分離308、canonical、robots、sitemapを確認する。

旧nameserver値、最終backup、直前Worker versionをrollback記録として保持します。nameserver切替後も旧WordPress／SmugMugは削除しません。

### 切替結果

2026-09-02 06:53:55 JSTにCloudflare zoneの`active`を確認し、2 Custom Domainを適用しました。

- .com親DNSと主要public resolverは`desi.ns.cloudflare.com` / `harlan.ns.cloudflare.com`を返す。
- `blog.kanouk.com` / `photos.kanouk.com`はWorker `kanouk-emdash-staging`のproduction environmentへ接続済み。
- `workers_dev` / `preview_urls`は明示的に有効化し、既存staging URLも200を維持する。
- TLSは`kanouk.com` / `*.kanouk.com`を含み、両Custom Domainで200を返す。
- blog→photo route、photos→blog routeはqueryを維持して308。
- apexは200、wwwはapexへの301を維持する。
- 本番全件crawlは4,056 page / 6,490 internal link、残存参照0。一時timeout 4件は各3回の対象再監査12/12で200。

切替証拠の機械可読要約は`production-cutover-2026-09-02.json`に保存しています。macOSのローカルresolverは旧NSをTTL中保持したため、切替直後の検証は.com親DNS、1.1.1.1、Cloudflare権威DNS、固定SNI/TLS接続を併用しました。ローカルcacheだけを公開障害と判定しません。

## SmugMug owner OAuth後の再開（完了済みの復旧手順）

公開APIだけで原本一致まで確認できなかったassetだけを再開します。認証値はPrivate Vaultの`10_sensitive`からallowlist runnerが子processへ渡し、標準出力やGitへ出しません。

認証前のpreflightは書き込みを行わず、2026-09-01の実行では5 album／236 assetだけを選択しました。

```sh
cd /Users/kanouk/projects/kanouk.com
python3 scripts/migration/run_smugmug_readonly.py \
  resume_smugmug_owner_migration.py \
  --catalog migration/smugmug/catalog.json
```

ユーザー同席時に一度だけFull / Readを許可し、表示された6桁コードをterminalへ入力します。

```sh
python3 scripts/migration/authorize_smugmug_owner.py
```

その後、preflightの`owner_credentials`が`ready`であることを確認してから再開します。コマンドは`pending_owner_auth`を含むalbumだけを選び、既にverifiedのassetは再uploadしません。

```sh
python3 scripts/migration/run_smugmug_readonly.py \
  resume_smugmug_owner_migration.py \
  --catalog migration/smugmug/catalog.json \
  --apply --concurrency 2

python3 scripts/migration/run_smugmug_readonly.py \
  backfill_smugmug_metadata.py \
  --catalog migration/smugmug/catalog.json \
  --apply --continue-on-error

python3 scripts/migration/report_smugmug_migration.py \
  --catalog migration/smugmug/catalog.json
```

reportは2,168 verified、duplicate ID 0、manifest mismatch 0、`complete: true`になるまで完了扱いにしません。owner APIで公開catalog外のalbumが見えても自動追加・公開せず、40公開albumとの全件性比較だけを記録します。成功後にWordPress全件再import、全sitemap監査、backup／restore drillをもう一度実行します。

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

各時点のCloudflare・公開画面・404台帳は、同じread-only実行器でJSON化します。`--checkpoint`の時刻に達していない場合は終了コード2となり、早すぎる観測を正式な24時間／1週間監視として扱いません。

```sh
cd /Users/kanouk/projects/kanouk.com
python3 scripts/migration/monitor_production.py \
  --checkpoint 24h \
  --output docs/migration/monitoring/2026-09-03-24h.json
```

Codex heartbeat automation `yohaku-24`（表示名: `Yohaku移行 経時監視`）を、各checkpointにつき一回だけ07:15 JSTに実行する。初回は2026-09-03の24時間監視で、合格後に同じautomationを1週間、1か月、3か月の順へ更新し、3か月完了後はpauseする。別automationを重複作成しない。automationはローカル記録、テスト、commit/push、公開readbackまで行うが、旧WordPress／SmugMugの停止・削除・解約、Search Consoleの所有権・sitemap・設定変更、GitHub Issue本文・コメント・状態変更は、実行時のユーザー明示承認なしに行わない。

実行器は`kanouk@gmail.com`の最小権限tokenだけを使い、zone、Custom Domain、blog/photos/staging readback、Worker invocation error、D1の404 referrerを取得します。zone HTTP Analyticsは現在の最小権限tokenに`Zone Analytics Read`がないため、権限を勝手に広げず`not_available_to_minimum_scope_token`として記録します。Worker runtime errorと実media readbackは別経路で継続監視できます。

監視JSONはGoogle Application Default Credentialsを使い、GA4標準reportの`hostName`別`screenPageViews`／`activeUsers`をread-onlyで取得します。Search Consoleもsites listだけを試し、スコープ不足・所有権未確認は状態として記録します。所有権付与やsitemap送信は行いません。Cloudflare billable usage APIも最大31日ずつread-onlyで取得し、権限不足は明示します。同APIはCloudflare公式仕様上、billing integrationが完了するまでcost fieldを返さない場合があるため、usage取得成功だけで実費確定とはしません。

### 初回監視結果

2026-09-02 08:03 JST（切替約1時間後）に、zone `active`、Custom Domain 2件、blog 14/14・photos 12/12の代表readback、active deployment error rate 0%、asset 5xx 0を確認しました。旧カノログのGA4 measurement IDが初期releaseへ入っていないことを同時に検出したため、production hostだけで有効になるよう修正し、Worker version `86d6efcb-7a33-48db-85be-d7f66c29fe7b`へdeployしました。

修正後は両production hostでGA4 loaderとmeasurement IDを読み戻し、stagingではGA4なし・`X-Robots-Tag: noindex`を維持しています。GA4 realtimeとSearch Consoleは外部反映を未確認のためpendingです。

08:22 JSTまでのproduction実画面監査では、blog home／記事／検索／商品カード／クイズと、photosのalbum一覧／詳細／photo詳細を確認しました。商品画像、クイズの回答feedback、dark mode、写真の前後導線は成立しています。320 / 390 / 768 / 1024 / 1440pxで記事、home、商品カード、album、photo詳細を表示し、全幅で横overflow 0を実測しました。古い記事で月選択肢が直近36か月に限られ、カレンダーの対象月と選択表示が一致しない問題を発見したため、全移行期間240か月へ拡張しました。version `6da4bad2-7704-41e4-988a-48fca2611a23`で2008年6月の記事が同月を選択表示し、blog 14/14、photos 12/12、staging 14/14のreadbackが再合格しています。

同時点の404 logは、`.git`／`.env`／WordPress batch APIなどreferrerなしの自動探索と、monitor自身の意図的404が中心でした。正規ページからの壊れた導線を示すreferrer付き404は確認していません。経時監視では件数だけでなくpathとreferrerを分けて評価します。

08:56 JST、Gutenberg引用のnested paragraph/listを既存変換器が読まず、一部引用本文が空になる不具合を修正しました。`--only-quotes`の読み取りドライランで271件すべてが更新対象、対象外更新0、失敗0を確認してから、更新前D1をSQLへ退避・別SQLite復元検証し、271/271件を更新・再公開しました。更新後の再実行は271/271 `skipped_verified`、失敗0です。原本370引用に対し、公開posts 366、公開page 2、private revision 2、本文欠落0です。Worker version `44c7961e-7790-40ca-84e2-a748bd5e5254`で長文、複数段落、箇条書き、light／dark、390／1440px、横overflow 0を実画面確認し、3ホストの代表readbackも再合格しています。

09:16 JST、共通監視実行器の初回暫定runが合格しました。切替から約2時間23分でzone active、Custom Domain 2件、blog 14/14・photos 12/12・staging 14/14、Worker 18,727 invocation中runtime error 0、内部／外部referrer付き404 0でした。GA4はproperty `256487934`、stream `2210574206`、measurement ID `G-94EQ0WN7B9`を管理画面で照合し、Realtimeでactive users 4・page views 9を受信しています。host別帰属は標準reportの処理待ちです。

11:15 JST、監視実行器をreport version 2へ更新し、GA4／Search Console／Cloudflare billing usageのread-only観測を統合しました。GA4 Data APIはHTTP 200で、当日分の標準reportはまだ0行のため`pending_standard_processing_or_no_traffic`。Search Consoleは現在のADCに`webmasters.readonly`がなくHTTP 403、Cloudflare billable usageは最小権限tokenでHTTP 403として記録します。いずれも権限追加・設定変更・送信操作は行っていません。

11:36 JST、監視実行器をreport version 3へ更新し、D1のquery／row数とR2のoperation／storage量をCloudflare GraphQLからread-onlyで取得しました。R2 inventory 3,546件／6,978,619,128 bytesに対し、EmDash media APIが追跡するのは3,507件／6,933,980,178 bytesです。差分39件／44,638,950 bytesは現行media tableから参照されていませんが、不要とは推測せず、R2全件backupへ含めます。

11:50 JST、監視実行器をreport version 4へ更新し、公式料金snapshotとYohaku単体の利用量を同じJSONで比較できるようにしました。Workers／D1／R2の同梱枠はaccount-wideであり、切替当日の値にはmigration、backup、検証、monitor自身のtrafficも含まれるため、通常月へ年率換算しません。確定請求やCPU usageと、観測可能なresource usageを混同しない構造です。

11:57 JST、監視実行器をreport version 5へ更新し、Images unique transformationsをaccount-wide analyticsからread-onlyで取得しました。9月累計242件、9月2日分7件で、月5,000件の無料枠に対する残りは4,758件です。Yohakuだけへの帰属はdataset上分離できないため、account-wide実測とYohaku contract上限を別々に保持します。

12:08 JST、監視実行器をreport version 6へ更新し、Workers StandardのCPU合計をCloudflare GraphQLからread-onlyで取得しました。9月のaccount-wide推定は4,163,572.355 CPU ms、切替後のYohaku Worker推定は422,358.830 CPU msです。前者を月30,000,000 CPU msの同梱枠と比較し、残り25,836,427.645 CPU msを確認しました。`AdaptiveGroups`の値は適応サンプリング推定であり、account-wideとWorker単体は独立に推定されるため厳密な差し引きには使いません。CPU未観測は解消しましたが、確定請求は請求明細のmeterを正本とします。

12:17 JST、`kanouk@gmail.com`のCloudflare Billingをブラウザでread-only確認しました。8月31日〜9月2日の従量課金合計とcycle予測はいずれも$0.00で、表示されたR2／KV／D1／Workers／Imagesはすべてbillable usage 0でした。9月1日の請求$5.50は`Paid`です。請求番号、支払い方法、請求先住所は記録せず、請求内訳も開いていないため$5.50の構成は推測しません。同額が12か月続き、追加従量課金がなければ年間$66、SmugMug年$100との差は年$34ですが、単一請求からの暫定値として扱います。機微情報を除いた表示値は`cloudflare-billing-snapshot-2026-09-02.json`へ保存しました。

12:26 JST、`kanouk@gmail.com`でGoogle Search Consoleの`sc-domain:kanouk.com`をread-only確認し、「このプロパティへのアクセス権がありません」を確認しました。所有権証明ボタンは押さず、sitemap送信もしていません。APIのscope不足とは別に、ログイン済みUIでもproperty accessがないことをreport version 8と`search-console-access-2026-09-02.json`へ記録しました。次の外部変更は所有権証明であり、実行時の明示承認が必要です。

12:34 JST、監視実行器をreport version 9へ更新し、GA4 Realtime Data APIをread-onlyで追加しました。property `256487934`のexpected stream `2210574206`（カノログ）で直近30分の1 view／1 active userをHTTP 200で確認しました。Realtime APIは`hostName` dimensionを提供しないため、これは対象streamへの受信確認であり、`blog.kanouk.com`／`photos.kanouk.com`のhost別帰属を証明しません。host別は標準`runReport`の処理待ちとして分離します。

## Cloudflare staging backup

最終import後、Privateの外部原本領域へD1 SQLとR2全objectを保存します。EmDash media APIだけでなくR2 inventoryを直接列挙し、media tableから参照されないobjectも削除せず保全します。

```sh
cd /Users/kanouk/projects/kanouk.com

# 件数と総byteのdry-run
python3 scripts/migration/backup_cloudflare_staging.py

# D1 export + R2全object download + hash台帳
python3 scripts/migration/backup_cloudflare_staging.py --apply --concurrency 4

# 上の出力に表示されたbackup directoryを指定
python3 scripts/migration/verify_cloudflare_backup.py \
  /Users/kanouk/Documents/Private_External_Imports/kanouk-cloudflare-backups/<timestamp> \
  --output /tmp/kanouk-backup-verification.json
```

backupは次を満たした場合だけ成功です。

- D1 SQLのSHA-256とbyte数がmanifestに一致。
- R2全objectのSHA-256とbyte数がmanifestに一致。
- EmDash mediaがR2 inventoryの部分集合であり、両方の件数・合計byteがmanifestに一致。
- D1 SQLを一時SQLiteへ流し込める。
- `PRAGMA integrity_check`が`ok`。
- 復元後のtable数が0ではない。

WXR、SmugMug manifest、WordPress media ledger、旧新URL ledgerはR2 backupとは別に保存します。credential、PAT、Application Passwordはbackupへ混ぜません。

2026-09-02のversion 2 backupは`20260902T023451Z`です。R2全3,546件／6,978,619,128 bytesを照合し、EmDash追跡3,507件と未追跡39件を分けてmanifestへ記録しました。別SQLiteへの復元は85 table／40,273 row、`integrity_check=ok`、foreign key違反0です。

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
- Images: `preview-v1`のunique transformations。R2保存量をImages料金へ二重計上しない

公式価格:

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/images/pricing/

2026-09-02 11:50 JSTの暫定baseline:

| 項目 | Yohaku観測値 | 月間同梱／無料枠 | 判定 |
|---|---:|---:|---|
| Workers requests | 23,289 | 10,000,000 | 枠内 |
| D1 rows read | 11,209,615 | 25,000,000,000 | 枠内 |
| D1 rows written | 7,294 | 50,000,000 | 枠内 |
| D1 storage | 76,337,150 bytes | 5,000,000,000 bytes | 枠内 |
| R2 storage snapshot | 6,978,619,128 bytes | 10,000,000,000 bytes-month | 枠内 |
| R2 Class A | 18 | 1,000,000 | 枠内 |
| R2 Class B | 211 | 10,000,000 | 枠内 |
| Images unique transformations | account-wide月累計242（Yohaku contract上限3,507） | 5,000 | 実測・上限とも枠内 |

現在のWorkers Paid最低額は月$5／年$60です。観測済みresourceだけなら追加overageは示されておらず、SmugMug年$100との差は最大年$40です。ただし、これは削減額の確定値ではありません。Workers CPU、同じaccount内の他resource、Cloudflare請求明細が未確認なので`provisional_floor_only`とします。1週間では通常trafficとの分離、1か月では請求明細と再backupを確認してから実費を確定します。

Workers Paid最低額だけなら年$60ですが、SmugMug年$100との差額をそのまま確定削減額にはしません。request／CPU／storage／operation／ImagesとWordPress hosting費を実測し、Cloudflareの請求期間後に確定します。

## 解約判断

次が揃っても自動解約しません。

- 全asset / media / contentの最終状態が説明可能。
- 旧URL対応とSEO監視が一定期間安定。
- backupとrestore drillが成功。
- 実費と削減額が説明可能。

条件が揃った時点で「解約可能性がある」と報告し、実際のSmugMug／WordPress停止・削除・解約はユーザーの別途明示指示を待ちます。
