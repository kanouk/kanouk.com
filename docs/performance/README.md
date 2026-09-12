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

| 対象 | gzip合計 | CI上限 |
| --- | ---: | ---: |
| 管理エントリー＋静的依存 | 794,450 bytes | 850,000 bytes |
| 全CSS（管理も含む） | 58,527 bytes | 70,000 bytes |
| 公開計測スクリプト＋静的依存 | 4,254 bytes | 15,000 bytes |

全ページの初期転送量ではない。画像・HTML・外部スクリプトは別計測。変更中の分離前ビルドでは管理エントリー単体が1,791,569 bytes gzipだった。単体と依存込みを同一指標として比較しない。

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
