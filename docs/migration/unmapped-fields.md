# 未完了事項と移行ゲート

「未確認」と「実装・移行・readback済み」を分けて管理します。2026-09-02現在、Cloudflare基盤、WordPress全件、公開写真2,168件、最終全件crawl、backup／restore drill、独自ドメイン切替、初回監視まで成立しています。残作業は24時間以降の経時監視と外部サービスの反映確認です。

## 現在のblocker

| 項目 | 状態 | 次の操作 |
|---|---|---|
| nocalog / art-quiz現在の非公開差分 | 公開REST件数はWXRと一致、管理者認証は未所持 | WXRの下書き・非公開を正本として保持し、公開差分がないことを明記 |
| DNS / 本番URL | nameserver変更、zone active、2 Custom Domain、TLS、本番readback、全件crawl済み | なし。経時監視は別行で継続 |
| 検索・分析の外部処理 | custom domain公開済み。GA4 tagはproductionのみreadback済み。Search Console／GA4 realtimeの反映は非同期 | 24時間・1週間・1か月・3か月の時点で確認し、pendingを事実として記録 |

## WordPressで確認済み

- WXR 3件から投稿1,847、固定ページ7、合計1,854コンテンツを抽出。
- 状態はpublish 1,848、draft 3、private 3。privateは公開せず元状態をmetadataへ保持する。
- WXR添付2,027件にarchiveから回収した1件を加え、2,028件すべてをsource／R2 readback hash一致でverified。JPEG / PNG / GIF / WebP / SVG / PDF / XLSX / MP3を含む。
- コメントは127件（approved 65、pending 62）。IPとUser-Agentは移行しない。
- 16,701ブロックへ変換し、通常の`htmlBlock`は0件。テーマ／プラグイン名ではなく`yohaku.*`の意味ブロックへ正規化する。引用370件は`yohaku.quote`へまとめ、本文欠落0をD1で確認済み。
- kanolog管理者RESTでPochipp 590件、再利用ブロック3件、menu item 10件、featured media付き投稿93件を確認した。
- kanologの現在公開投稿は1,370件。WXR公開1,368件との差は保存済みREST deltaの2件と一致する。
- nocalogは公開183投稿・1ページ・62添付、art-quizは公開291投稿・603添付で、現在RESTとWXR公開件数が一致する。
- 1,854コンテンツをmedia完成後に再importし、再実行は`skipped_verified` 1,854、失敗0。
- コメント127件はapproved 65／pending 62を保持し、IP／User-Agentを除外して移行済み。
- 移行済みリンクカード50記事をsite-scopedな正規URLへ更新。全件再実行は`skipped_verified` 1,854、公開crawlの`wordpress://`は0件。

## WordPressの公開再確認

- Pochipp、quiz、画像枠、長文／短文記事はYohaku stagingでdesktop / mobile / darkを確認し、独自ドメインが同じWorker versionを返すことをreadback済み。
- 旧WordPress uploads、SmugMug、Gutenberg comment、既知shortcodeは最終crawlで0件。

## SmugMugで確認済み

- 40アルバム、2,168アセット（JPEG 2,156、MP4 12）。
- source相当6.465GB、公開archive相当5.931GB。2,003件に公開ArchivedUri/MD5があり、165件にはない。
- GPSを持つ資産は1,114件。GPS EXIFは削除せず、写真詳細とアルバム地図へ利用する。
- 36アルバムがdownload許可、4アルバムが不許可。新UIもこの設定を尊重する。
- protected設定は7アルバム／339資産。公開API上の対象2,168件はすべて`CanShare=true`。
- title 934件、caption 687件、keyword利用2件。コメントは全アルバム合計0件。
- source highlight imageをカバー選択へ保持し、未取得時だけ決定的fallbackを使う。
- 公開JPEGが有効でもsource MD5と一致しない場合は縮小版を採用しない。
- 40 album、2,168 assetすべてverified。pending 0、重複ID 0、manifest不一致0。

## SmugMugで完了した最終監査

- owner OAuthで公開対象40 albumの全件性を確認。
- `pending_owner_auth` 236件を原本一致へ収束。
- 12 MP4、poster、Range、mobile表示を確認。
- metadata backfillを完了し、EXIF／GPS／keywordを保持。
- source highlight、件数、position、title、caption、日時をmanifestへ保持。

## EmDash / Yohakuで確認済み

- 公開／非公開status、Portable Text、media、taxonomy、commentのモデルと冪等import経路。
- 写真一覧・詳細、カバーcrop、原寸比を保つ個別表示、低解像度の非拡大。
- 全画面、前後移動、キーボード、swipe、スライドショー、共有、download policy。
- GPS地図、EXIF、keyword表示、写真・動画・アルバム検索。
- Noto Sans JP、白／near-black、青の限定accent、moderate見出し、dark mode、Lucide icon。
- production host別のblog / photoルーティングとsitemap分離。workers.devはnoindexのQA面として維持。
- 移行済み記事の管理画面で`yohaku.steps`が「手順」として表示され、専用フォームを開いて再編集できることを確認。変更を破棄した後、公開3 stepsが未変更であることもreadback済み。
- SmugMug代替は、EmDashのcontent type／media APIを利用するこのリポジトリ独自の公開写真UI。EmDash coreのforkではない。

## 最終チェック

```text
[x] Cloudflare email = kanouk@gmail.com
[x] guardでfragrance.radio@gmail.com側への誤操作を拒否
[x] staging D1 / R2 / Worker / KV作成
[x] WXR 3件のhashと件数を固定
[x] SmugMug owner OAuth実行器を用意
[x] owner OAuth待ち5 album／236件だけを選ぶfail-closed再開器を用意
[x] SmugMug owner OAuthを認可し対象だけ再開
[x] SmugMug 2,168件を最終状態へ収束
[x] WordPress media 2,028件を最終状態へ収束
[x] content 1,854件／comments 127件をimportし公開readback
[x] D1 / R2 backupとrestore drill
[x] `wordpress://`を再importし公開crawlで0件を確認
[x] URL / SEO / desktop / mobile / dark mode最終監査
[x] DNS切替をユーザーが明示承認
[x] registrar認証後にnameserver切替
[x] custom domainで本番readback
[x] 切替約1時間後のzone/domain/Worker 5xx/代表readback確認
[x] GA4をproduction 2ホストだけへ継承しstagingから除外
[ ] 1週間・1か月・3か月の経時監視と実費確定
```
