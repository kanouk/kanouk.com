# kanolog.net のURL移転

Googleへの移転通知のため、旧URLから対応する新URLへ301転送する。転送は専用Worker `kanolog-redirect` に置き、旧WordPressの稼働に依存させない。ブログ・写真サイトのWorkerとDBには変更を加えない。

## 対応表

現行WordPressの公開記事1,370件・固定ページ3件と、D1の公開・削除されていない移行先をsource IDで照合した。トップを含む1,374件に、カテゴリー7件・タグ69件を加えた1,450件をCSVへ保存した。下書きは含まない。

- [URL対応表](kanolog-redirects-2026-11-10.csv)
- 実行用データ: `apps/kanolog-redirect/mapping.json`
- HTTP/HTTPS、wwwの有無、末尾スラッシュ、`?p=ID`・`?page_id=ID`を扱う。
- カテゴリー・タグの旧パスとクエリ、検索、RSS、sitemapも対応する新URLへ転送する。
- 不明なURL・非公開ID・未対応の添付IDは404。無関係なページへ一括転送しない。
- uploads・添付ページ・日付別アーカイブなど、対応表にないURLは自動で推測しない。

## 公開手順

1. 専用Workerのworkers.devで301とLocationを検証する。この確認用ホストにはnoindexを付ける。
2. Cloudflareへkanolog.netのDNS zoneを追加する。既存DNSを全件保全し、MX・TXT・所有権確認のレコードを保持する。メール転送設定を自動で作り替えない。
3. apexとwwwを専用Workerへ接続し、旧DNSからCloudflareへ委任する。TLS成立と通常の名前解決を確認する。
4. 旧URLからの301、転送先200、canonical、クロール許可を検証する。Worker単体の検証を旧ドメインの公開完了と扱わない。
5. 同じGoogleアカウントで旧・新プロパティの所有権を確認し、Search Consoleの「アドレス変更」を申請する。wwwなどの旧プロパティも確認する。新sitemapを送信する。
6. ドメインと転送を少なくとも1年間維持する。ドメイン更新の実行・決済は別途確認する。旧サーバーの稼働は不要。

## 状態

2026-11-10、対応表と専用Workerを作成し、workers.devへ配備した。旧ドメインは引き続きムームーDNS・旧WordPressを利用しており、切り替えは未実施。既存Cloudflare tokenにはzone作成権限がなく、ブラウザー操作もWork設定で無効だったため、DNSの切り替え・ドメイン更新・Search Console申請はまだ行っていない。

転送先1,450件のHTTP 200を確認した。初回に古い302→404のキャッシュを検出したが、期限切れ後の再取得で全件の正常応答を確認した。キャッシュ削除APIには権限がなく、削除操作は成立していない。切り替え直前にも状態を再確認する。専用Workerの検証結果とreadbackはPRと非公開監査記録へ保存する。

## 検証と戻し方

`node --test apps/kanolog-redirect/worker.test.mjs`

旧URLの全対応、プロトコル・host・末尾スラッシュ、公開ID限定、完全一致、未知URLの拒否、HEAD、POST拒否、robots、確認用ホストのnoindexを検証する。GitHub Actionsでも同じテストを実行する。

切り替え前のnameserverとDNS全件を書き戻せる状態で保全する。問題があれば旧nameserverへ戻す。専用Workerはブログの配信と独立しているため、転送の変更で記事データを書き換えない。

根拠: [Googleのサイト移転ガイド](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes)、[Search Consoleのアドレス変更](https://support.google.com/webmasters/answer/9370220)。301の設置後に申請し、申請受付とGoogleの検索結果への反映を区別する。
