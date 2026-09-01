# 未完了事項と移行ゲート

「未確認」と「実装済みだが全件実行待ち」を分けて管理します。2026-09-01現在、Cloudflare基盤とデータモデルは成立しており、主な残作業は全件転送・所有者認証・最終監査です。

## 現在のblocker

| 項目 | 状態 | 次の操作 |
|---|---|---|
| SmugMug完全原本 | 公開取得したJPEGの一部が`ArchivedMD5`と不一致、公開archive URIなしも165件 | ユーザー同席時にFull/Read OAuthを認可し、`pending_owner_auth`だけ再取得 |
| WordPress添付 | 2,027件の再開可能転送を実行中 | 完走後に失敗だけ再実行し、全件のsource/readback SHA-256を確定 |
| 本文media参照 | 1,854コンテンツは先行import済みだが、media台帳完成前 | media完了後に全件再importし、2回目が`skipped_verified`になることを確認 |
| nocalog / art-quiz現在の非公開差分 | 公開REST件数はWXRと一致、管理者認証は未所持 | WXRの下書き・非公開を正本として保持し、公開差分がないことを明記 |
| DNS / 本番URL | `blog.kanouk.com` / `photos.kanouk.com` は設計済み、未切替 | 全監査合格後に切替候補を提示。別途明示指示なしに変更しない |

## WordPressで確認済み

- WXR 3件から投稿1,847、固定ページ7、合計1,854コンテンツを抽出。
- 状態はpublish 1,848、draft 3、private 3。privateは公開せず元状態をmetadataへ保持する。
- 添付は2,027件。JPEG / PNG / GIF / WebP / SVG / PDF / XLSX / MP3を含む。
- コメントは127件（approved 65、pending 62）。IPとUser-Agentは移行しない。
- 17,050ブロックへ変換し、通常の`htmlBlock`は0件。テーマ／プラグイン名ではなく`yohaku.*`の意味ブロックへ正規化する。
- kanolog管理者RESTでPochipp 590件、再利用ブロック3件、menu item 10件、featured media付き投稿93件を確認した。
- kanologの現在公開投稿は1,370件。WXR公開1,368件との差は保存済みREST deltaの2件と一致する。
- nocalogは公開183投稿・1ページ・62添付、art-quizは公開291投稿・603添付で、現在RESTとWXR公開件数が一致する。

## WordPressで残る監査

- 2,027添付の最終成功／失敗／重複件数と総byte数。
- verified mediaだけで本文、featured image、`srcset`、画像リンクが新URLへ置換されたこと。
- Pochipp、quiz、SWELL/JIN/Jetpack/WPMF表現の代表記事をdesktop / mobileで比較すること。
- コメント公開65件とpending 62件が公開範囲を違えず移行されたこと。
- 公開HTMLから旧WordPress uploads URL、SmugMug URL、未変換shortcodeが消えたこと。

## SmugMugで確認済み

- 40アルバム、2,168アセット（JPEG 2,156、MP4 12）。
- source相当6.465GB、公開archive相当5.931GB。2,003件に公開ArchivedUri/MD5があり、165件にはない。
- GPSを持つ資産は1,114件。GPS EXIFは削除せず、写真詳細とアルバム地図へ利用する。
- 36アルバムがdownload許可、4アルバムが不許可。新UIもこの設定を尊重する。
- protected設定は7アルバム／339資産。公開API上の対象2,168件はすべて`CanShare=true`。
- title 934件、caption 687件、keyword利用2件。コメントは全アルバム合計0件。
- source highlight imageをカバー選択へ保持し、未取得時だけ決定的fallbackを使う。
- 公開JPEGが有効でもsource MD5と一致しない場合は縮小版を採用しない。

## SmugMugで残る監査

- owner OAuthで非公開APIを含む全件性を再確認する。
- `pending_owner_auth`を原本一致へ収束させる。
- 12 MP4の全件再生、poster、Range、mobileを最終確認する。
- metadata backfillを全件実行し、EXIFとkeywordを再監査する。
- source highlight、件数、position、title、caption、日時を40アルバムすべて照合する。

## EmDash / Yohakuで確認済み

- 公開／非公開status、Portable Text、media、taxonomy、commentのモデルと冪等import経路。
- 写真一覧・詳細、カバーcrop、原寸比を保つ個別表示、低解像度の非拡大。
- 全画面、前後移動、キーボード、swipe、スライドショー、共有、download policy。
- GPS地図、EXIF、keyword表示、写真・動画・アルバム検索。
- Noto Sans JP、白／near-black、青の限定accent、moderate見出し、dark mode、Lucide icon。
- production host別のblog / photoルーティングとsitemap分離。workers.devはnoindexのQA面として維持。

## 最終チェック

```text
[x] Cloudflare email = kanouk@gmail.com
[x] guardでfragrance.radio@gmail.com側への誤操作を拒否
[x] staging D1 / R2 / Worker / KV作成
[x] WXR 3件のhashと件数を固定
[x] SmugMug owner OAuth実行器を用意
[ ] SmugMug owner OAuthをユーザー同席で認可
[ ] SmugMug 2,168件を最終状態へ収束
[ ] WordPress media 2,027件を最終状態へ収束
[ ] content / comments再importと公開readback
[ ] D1 / R2 backupとrestore drill
[ ] URL / SEO / desktop / mobile / dark mode全監査
[ ] DNS切替は別途ユーザー判断
```
