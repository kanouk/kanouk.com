# kanouk.com Cloudflare staging

Issue #4 のための EmDash / 公開写真ステージングアプリです。1つの Worker、1つの D1、1つの公開写真用 R2 を共有し、ホスト名とコレクションを分けます。

## 対象

- Blog: `blog.kanouk.com`
- Public photos: `photos.kanouk.com`
- Worker: `kanouk-emdash-staging`
- D1: `kanouk-content-staging`
- R2: `kanouk-public-media-staging`
- KV: `kanouk-emdash-staging-session`

プライベート写真と Gyazo 代替は対象外です。Cloudflare 資源は `kanouk@gmail.com` のアカウントにのみ作成します。`fragrance.radio@gmail.com` の既存資源は変更しません。

## Local development

暗号化キーはリポジトリに置かず、Private Vault の `10_sensitive/api-keys/Cloudflare-kanouk.md` から子プロセスへだけ渡します。

```bash
bun install
bun run dev
```

検証:

```bash
bunx emdash seed --validate seed/seed.json
bun run typecheck
bun run build
python3 -m unittest discover -s ../../tests -v
```

## Cloudflare deployment guard

デプロイ前に同じ sensitive ノートへ `kanouk@gmail.com` 専用の Account ID と scoped API token を設定します。値を shell 引数や Issue に貼りません。

```bash
python3 ../../scripts/cloudflare/run_wrangler_kanouk.py --preflight-only
bun run migrate:status
bun run deploy
```

guard は `wrangler whoami --json` のアカウント集合が指定 Account ID の1件だけであることを確認します。`login` / `logout` は既存の `fragrance.radio@gmail.com` セッションを壊すため拒否します。

Remote EmDash content/media operations use `scripts/cloudflare/run_emdash_kanouk.py`. It reads the scoped staging token only from `10_sensitive/api-keys/EmDash-kanouk.md`, pins the Workers.dev origin, proves access to the expected albums/photos/posts schema before every command, and does not use EmDash's global `~/.config` credential store. The token was issued by the signed-in `kanouk@gmail.com` admin; least-privilege tokens cannot call EmDash `whoami` because that route requires the broader `admin` scope.

D1 migration の適用は、まず `bun run migrate:status` が表示する target fingerprint を確認し、同じ fingerprint を明示して実行します。これにより、別アカウントや別DBへの非対話適用を拒否します。

```bash
python3 ../../scripts/cloudflare/run_emdash_migration_kanouk.py \
  --wrangler-config wrangler.jsonc \
  --expected-target-fingerprint <confirmed-fingerprint>
```

## Provisioned staging resources

2026-08-31 に `kanouk@gmail.com` 側へ次を作成しました。Account ID、API token、暗号化キーはこのリポジトリや公開 Issue へ記録しません。

| Resource | Name | Purpose |
| --- | --- | --- |
| Worker | `kanouk-emdash-staging` | EmDash admin、blog、public photos の共通 origin |
| D1 | `kanouk-content-staging` | EmDash core schema と5 collectionのstagingデータ |
| R2 | `kanouk-public-media-staging` | インターネットへ公開可能な原本メディアのみ |
| KV | `kanouk-emdash-staging-session` | EmDash session |

- Staging URL: `https://kanouk-emdash-staging.kanouk.workers.dev`
- 管理者: `kanouk@gmail.com` / 表示名「カノ」 / passkey認証
- EmDash migration: 69件適用済み。再適用確認は `pending: none` / `unknownApplied: none` / `executed: none`
- Synthetic fixture: post 1、page 1、album 1、photo 1、media 1、user 1

## Public media contract

- R2 object key は EmDash 管理の `<ULID>.<extension>` とし、移行スクリプト側で独自の公開URLを組み立てません。
- 公開HTMLは生のR2管理URLではなく、同じWorkerの `/_emdash/api/media/file/<storage-key>` を参照します。
- 現在の画像レスポンスは正しい `Content-Type` と `Cache-Control: public, max-age=31536000, immutable` を返します。CORSヘッダーは付けず、同一originから利用します。
- Range要求は現時点では `206` ではなく全体の `200` を返します。写真pilotでは許容しますが、SmugMugのMP4 12件を移す前に動画配信経路を別途検証します。
- 初期pilotでは派生画像を作りません。Cloudflare Images transformsは有料化せず、必要性と費用を本番移行前に判断します。
- このbucketには公開サイトへ出せるメディアだけを入れます。private写真、Google Photos代替、Gyazo代替、限定公開を装ったセンシティブ画像は別Issue・別アクセス設計なしに取り込みません。

## Staging behavior

- `photos.kanouk.com` / `photos-staging.kanouk.com` の `/` は `/albums` へ内部 rewrite します。
- `*.workers.dev` と staging hostname には `X-Robots-Tag: noindex, nofollow` を付けます。
- seed の記事・アルバム・写真は合成データで、`deleteBeforeProduction` を付けています。
- 公開 byline は、カノログの WordPress 表示名と現在の公開プロフィールに合わせて「カノ」とします。技術識別子の slug は `kanouk` のまま維持し、nocalog の `noca` と美術クイズの `artquiz` は移行時に別 byline として保持します。
- Cloudflare Images の変換は初期費用に含めず、Astro の画像処理は `passthrough` です。
- Dynamic Workers が必要な plugin marketplace と sandboxed plugin は有料Workersプランを避けるため初期構成に含めません。Webhook通知やmarketplaceが必要になった時点で費用対効果を再評価します。

## Verified staging checks

2026-08-31 に以下を確認しました。

- `bunx emdash seed --validate seed/seed.json`
- `bun run typecheck`（0 errors / 0 warnings）
- `bun run build`
- `python3 -m unittest discover -s ../../tests -v`（12 tests）
- remote D1 migration再実行がno-op
- R2 test objectのremote upload / download / SHA-256一致 / delete
- `/`、post、albums、album、photo、RSSがすべてHTTP 200
- Workers.devの全確認routeが `X-Robots-Tag: noindex, nofollow`
- desktop / 390x844 mobileでblog homeとphoto pageを目視確認
- EmDash adminへ作成済みpasskeyでサインインし、管理者名「カノ」と公開byline「カノ」を確認

`kanouk.com`のCloudflare zone作成と`blog.kanouk.com` / `photos.kanouk.com` Custom Domain設定は完了しています。nameserver切替はregistrar認証後に実施します。旧WordPress／SmugMugには変更を加えておらず、停止・解約は対象外です。

## Rollback and teardown

Workerコードだけを戻す場合は、対象commitをrevertしてguard付きの `bun run deploy` を実行します。WorkerのrollbackではD1とR2のデータは戻りません。

staging一式を完全撤去する場合は、次の順序で行います。

1. custom domainとDNS routeが未設定または切断済みであることを確認する。
2. 必要ならD1 exportとR2 objectの退避を作る。削除後のD1/R2には自動復旧手段がありません。
3. Worker `kanouk-emdash-staging` とcron triggersを削除する。
4. KV `kanouk-emdash-staging-session` を削除する。
5. D1 `kanouk-content-staging` を削除する。
6. R2 `kanouk-public-media-staging` を空にしてbucketを削除する。
7. この作業専用API tokenを失効させる。credentialを1Passwordへ移した後は、Private Vaultの暫定tokenも除去する。

削除操作もguardで `kanouk@gmail.com` の単一accountと確認できた場合だけ実行し、`fragrance.radio@gmail.com` のresource一覧との差分を先に確認します。
