# 性能改善の検証記録（2026-09-12）

対象: 公開ブログ、写真サイト、EmDash管理画面。追跡は [#20](https://github.com/kanouk/kanouk.com/issues/20)。

## 修正と根拠

- 写真整理の起動時の全写真走査を廃止。件数はSQL集計、写真は選択アルバムの50件だけ取得する。検索・要確認フィルターはアルバム全体に適用する。直リンクは対象写真を含むページへ移動し、先頭にも戻れる。
- 通常の並べ替えは表示中のpositionを入れ替え、未表示の写真を動かさない。重複positionの正規化、撮影日順、一括公開は明示操作のときだけ全アルバム写真を取得する。更新は従来のリビジョンAPIを使い、非表示行の更新でDOMを全件に増やさない。
- 公開アルバムも50件ずつSSR。JSなしでも通常リンクで移動できる。写真から戻るURLで対象ページを解決し、順序とアンカーを維持する。地図データは地図を開いたときだけ取得する。
- 管理読み取りは編集用リビジョン、公開一覧・地図はliveリビジョンを使用。削除・下書き・公開前のアルバム移動を混同しない。
- D1のリクエスト単位coalescingを有効化。同時に発行された読み取りの通信回数を減らす。既存の設定キャッシュは重複実装しない。設定／フッターページ、記事分類／関連記事を並行取得する。
- カレンダーのための記事本文取得を日別COUNTへ変更。
- 原本の公開・認証判定後にR2から直接配信し、CMS初期化の再実行を避ける。private/no-store、SVG等のattachment、CSP、条件付き応答、Range配信を保持する。Server-Timingに公開判定と変換待ちを追加する。
- 管理画面のプラグイン用グラフ描画を遅延読み込みにする。Phosphorのルートimportから全SSRアイコンが入るため、同じexportの個別importへ変換する。上流のimport形状が変わる場合はビルドを停止する。
- 通常遷移に120ms後の応答表示を追加。既存hover prefetchは維持する。
- 公開LCP/INP/CLSを既存GA4へ送信。ページ種別だけを付け、本文・検索語・要素・新しい識別子は付けない。管理画面の分析送信は追加しない。perf-auditクエリはコンソールだけに診断を出す。

## 変更前のHTTP計測

日本の同じMacからcurlを直列実行。各条件20件。p75はnearest-rank、p95は50件未満では算出しない。クエリを変えても実際のCF-Cache-Statusで分類する。DNS/TLSを含むHTTP TTFBであり、ブラウザー表示完了やRUMではない。

| 対象 | 条件 | TTFB p75 |
| --- | --- | ---: |
| blog / | MISS | 1,366.8ms |
| blog /posts | MISS | 869.56ms |
| photos /albums | MISS | 353.39ms |
| 管理Posts / limit=50 | 認証PAT | 863.64ms |
| 管理Media / limit=50 | 認証PAT | 451.76ms |
| 管理Photos / limit=50 | 認証PAT | 800.83ms |

原データ: before-miss.json、before-admin.json。旧写真整理の全件走査は公開写真2,168件に対し約22ページ分。新経路は件数に依存せず1ページから表示する。

## ビルド予算と回帰テスト

test:performance-buildは実際の生成ファイルの静的importを再帰的にたどる。dynamic importは初期量に含めない。

オーナー方針（2026-10-17）：管理画面はオーナーだけが使うので重くてよい。訪問者向けのページをできるだけ速くする。管理画面の上限は暴走を止めるための緩い歯止め、公開ページの上限は厳しめにする。

| 対象 | gzip合計（1.3.0時点） | CI上限 |
| --- | ---: | ---: |
| 管理エントリー＋静的依存 | 1,238,464 bytes | 2,000,000 bytes |
| 管理画面のCSS（`styles.*.css`） | 41,108 bytes | 80,000 bytes |
| 公開ページのCSS（管理画面のCSS以外の合計） | 28,460 bytes | 32,000 bytes |
| 公開計測スクリプト＋静的依存 | 4,366 bytes | 15,000 bytes |

公開ページのCSSは全チャンクの合計で、1ページが読み込むのはその一部（記事ページで約24KB）。

全ページの初期転送量ではない。画像・HTML・外部スクリプトは別計測。

EmDash 0.40.1への更新で管理エントリー上限を850,000から1,150,000 bytesへ変更した。0.35.0時点は794,059 bytes。上流の管理バンドル自体がgzipで約165KB増えた（328,937→493,991 bytes、日付選択の25言語ロケールなどの新機能）。0.40.1が導入したPhosphorアイコンの名前空間import（全アイコン、約950KB gzip）は、ビルド時に実際に使う18個だけへ変換している（scripts/direct-phosphor-imports.mjs）。公開ページの計測スクリプトとCSSは影響を受けない。1.0.1では1,113,253 bytes（上限内）。1.1.0では1,212,120 bytesとなり、上限を1,250,000 bytesへ変更した。増分約99KBのうち約56KBは、管理画面が`react-dom/client`を直接importするようになったため、Astroのハイドレーション用エントリーに含まれていたreact-dom/clientのチャンク（1.0.1でも管理画面で読み込まれていたが計測外）が計測対象に入ったもの。実際の増加は約43KB（管理バンドル本体約30KB、アイコン約8KB、日付処理とHTMLブロックの小さなチャンク）。追加されたCodeMirrorのコードエディタは遅延読み込みで、計測対象外。変更中の分離前ビルドでは管理エントリー単体が1,791,569 bytes gzipだった。単体と依存込みを同一指標として比較しない。

- 1万件のSQLite実行テスト: 初回50件、ページ間重複なし、後半の検索・直リンク、空アルバム、不正入力。
- 下書き移動・非公開・削除が公開一覧／地図に漏れないこと。
- Range/HEAD/304/412/416、private/no-store、SVGのセキュリティ境界。
- import変換の実export解決と上流変更時の失敗。
- UX 90件、migration 140件、Python 178件、型検査、ビルドを確認。
- ローカルAPIのアップロード→下書き保存、競合、匿名404／認証200。
- 120件のローカル合成データで50→100件表示、写真110への直リンク、先頭へ戻る、検索、並べ替えと復元、公開ページ3への復帰を実画面確認。

## 再現

apps/webで実行（Node 22.18以上）:

    npm run test:ux
    npm run test:migration
    npm run typecheck
    npm run build
    npm run test:performance-build

リポジトリ直下で実行:

    python3 scripts/migration/measure_performance.py --url https://blog.kanouk.com/ --url https://blog.kanouk.com/posts --url https://photos.kanouk.com/albums --samples 20 --fresh --output /tmp/after-miss.json
    python3 scripts/migration/measure_performance.py --url https://blog.kanouk.com/ --url https://blog.kanouk.com/posts --url https://photos.kanouk.com/albums --samples 21 --output /tmp/after-hit.json
    python3 scripts/migration/measure_admin_performance.py --samples 20 --organizer --output /tmp/after-admin.json

管理計測は既存のVault内PATをメモリー内で使う。認証情報・レスポンス本文を記録しない。HTTPを操作時間やCore Web Vitalsの合格判定に代用しない。

## リリースとロールバック

一つのPRで実装・計測記録のコミットに分ける。DBスキーマ変更、全キャッシュ削除、原本の書き換えはない。共通D1設定と生成アセットを同じビルドで検証するため、配信は一度の切り替えとする。

kanouk-emdash-stagingは名前に反して両公開ホストの本番Worker。ローカル.wranglerのD1/R2だけを編集検証に使う。リリースはCloudflareアカウントガードを通したnpm run deploy。直前のversionをdeployments list --jsonで保存し、問題があれば同じガード経由のrollback <version-id>で戻す。コミットSHA、Worker version、本番readbackと前後計測は #20 とPRに記録する。

5xx、画像の誤拒否、権限漏れ、保存不整合は直ちに切り戻し対象。同条件p75が20%以上悪化し再測定でも再現すれば原因を切り分ける。

## 観測待ちを完了扱いにしない

直後のHTTP値と画面検証はこの作業で記録する。24時間後・7日後のエラー／DB負荷／画像変換回数、RUM p75は時間と十分な件数が必要なため #26 に残す。全体の性能目標を満たしたと主張するには、その結果が必要。ブラウザー操作時間20回、固定CPU・回線での5回合成計測も、取得できた条件と未計測を区別する。

## D1との通信距離

初回リリースの後、341枚のアルバムMISS p75は2,486.74→684.11msへ改善した。一方でトップは1,401.78ms、管理Postsは892.02msで残課題となった。Server-TimingではSQL往復が約60msずつ積み上がっている。

D1のREST結果でprimary=HKG、read replication=disabledを確認。DBの複製や整合性を変えず、Workerに香港のplacement region hint（aws:ap-east-1）を指定する。これはAWSへデータを移す設定ではなく、その地域に近いCloudflare拠点でWorkerを実行する指定。配置を変えた結果は、HITを含めて再測定する。静的アセットは原則として最寄りのedgeから配信される。

公式仕様: https://developers.cloudflare.com/workers/configuration/placement/

D1のprimary配置が将来変わる場合はこのhintを再評価する。戻すにはplacement設定を除いて再デプロイするか直前のWorker versionへrollbackする。

## 公開ページの画像（2026-10-18）

写真の縮小版（`/_yohaku/media/preview-v2/{幅}/{形式}/{キー}`）は、R2の原本をImagesバインディング（`env.IMAGES`）で直接縮小する。以前のURL指定の変換（`cf.image`）は原本をこのWorker経由で取り直す必要があり、一部の大きな写真（4000×3000級、4〜6.5MB）で毎回約8秒かけて失敗し、原本がそのまま返っていた。アルバム一覧（スマホ）では画像だけで約27MBになっていた。Imagesバインディングが失敗した場合だけ従来の変換を試し、それも失敗したら原本を返す（#78の方針）。

ロゴ（`kanolog-logo.webp`、540px幅、7.5KB）とプロフィール写真（`kano-profile.webp`、4.7KB）はWebPにした。PNGはファビコン、ホーム画面アイコン、SNS用の代わりの画像として残す。

Googleアナリティクス（gtag、約165KB）は、ページの読み込み完了後の空き時間か最初の操作で読み込むため、表示の速さには影響しない。

## キャッシュがない時の応答（2026-10-18）

DB（D1）のprimaryは香港で、Workerも香港で実行する（上記）。日本からの往復と、1ページあたり8〜12回のDB問い合わせが、キャッシュがない時の応答時間の大半を占める。

- 記事ページでは、本文に依存しない問い合わせ（タグ、最近の記事、サイト設定）を記事の取得直後に始め、本文に依存する問い合わせ（SNS用の画像、写真へのリンク、最初の画像の大きさ）と同時に待つ。
- デプロイ後に `scripts/cloudflare/warm_public_cache.py` が主要な公開ページ（トップ、記事一覧、新しい記事12件、アルバム一覧、アルバム12件）を読み、実行した場所に近いデータセンターのキャッシュを温める。`npm run deploy` の最後で実行する。
- アルバムの写真一覧の `sizes` を実際の列幅（スマホ3列、タブレット4列、PCは最大80remの5列）に合わせた。以前はPCで20vwとしていたため、表示幅約232pxに768px幅の画像を選んでいた。計算にはページの左右の余白（`--gutter`、最大3rem）と写真の間隔（最大0.375rem×4）も含める。含めないと2倍の画面で480pxをわずかに超え、768pxを選んでしまう。サムネイルの大きさを変えた場合は、表示幅を測って `sizes` を書き換える。


## 縮小画像の保存と不要なCSSの除去（2026-10-25）

変更前の計測（日本のMacからcurl、本番）: キャッシュ済みHTMLのTTFBは55〜75msで十分速い。残っていたのは次の3点。

| 対象 | 変更前 | 原因 |
| --- | ---: | --- |
| 写真の縮小版（キャッシュなし） | 1枚 0.66〜1.80秒（変換 330〜1,600ms＋公開判定 30〜170ms） | 原本をImagesバインディングで毎回縮小。edgeキャッシュはデータセンターごとで、追い出されると再変換 |
| `leaflet.css`（6.3KB br、描画をブロック） | 全ページで読み込み | 管理画面のプラグイン（`src/studio/admin.tsx`）が`import("leaflet/dist/leaflet.css")`していた。プラグインのadmin entryはサイトのモジュールグラフに入るため、Astroが全ルートに`<link>`を付けていた |
| ロゴ・プロフィール画像 | `max-age=0, must-revalidate`、毎ページで再検証 | `/_astro/`外の静的ファイルにキャッシュ指定がなかった |

対応:

- 縮小版はR2の `_derived/preview-v2/{幅}/{形式}/q{品質}/{原本キー}` に保存し、2回目以降はどのデータセンターからでも変換せずに読む。保存時に原本のETagを `customMetadata.source` に記録し、一致するときだけ使う（原本が差し替わると作り直す）。保存は応答後（`waitUntil`）。公開判定（live参照のJSON走査）と並行して保存済み縮小版と原本ETagを取りに行き、公開と判定された場合だけ使う。`_derived/` はCMSが参照しないので生メディア経路から公開されることはなく、縮小版URLの原本キーとしても拒否する。EmDashの一覧はbackups/とstagingのprefixに限られるため、バックアップや取り込みには混ざらない。`X-Yohaku-Image-Source: resized|stored` で経路を確認できる。
- Leafletのスタイルは `src/client/map-style.ts` がビルド済みアセットURL（`?url`）を地図を開くときに`<link>`で読み込む。アルバムの地図、写真ビューアの地図、管理画面の地図が共通で使う。
- `public/_headers` でロゴ・プロフィール・ファビコン・代替画像に `max-age=86400, stale-while-revalidate=604800` を付けた（adapterが `/_astro/*` のimmutableを同じファイルに追記する）。
- ブログのフッター用ページ一覧、サイドバーの分類・トピック、月別アーカイブの問い合わせは `src/utils/shared-queries.ts` でリクエスト単位に共有し、トップと記事ページの先頭で開始する。以前はページ→レイアウト→各コンポーネントの順に直列で待っていた（1往復約60ms）。

検証: `scripts/media-variants.test.mjs` が擬似R2／Images／D1で「1回だけ変換して保存→2回目は保存済み→原本差し替えで再変換→非公開は404で保存しない」を実行する。ビルド後のマニフェストで公開ルートのstylesheetが `theme.css`（記事ページは加えて記事CSS）だけになることを確認した。公開CSS合計は28,460→25,503 bytes gzip。本番でのTTFB・画像応答の再計測はデプロイ後に行う。

残課題: 旧サイト（kanolog.net等）の画像を縮小する `external-v1` は保存しない（URL指定の変換のまま）。削除された原本の縮小版はR2に残る（公開判定で配信されないが容量は使う）。
