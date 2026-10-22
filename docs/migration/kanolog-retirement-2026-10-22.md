# kanolog.net 廃止前監査（2026-10-22）

## 判定

**旧WordPressはまだ停止しない。** 記事・コメント・添付の保存、旧画像参照の修正、公開ダウンロードの復旧を確認した。独立した転送の公開、旧契約の同居サイト・メール確認が残っている。

ユーザーの方針は「kanolog.net のドメインを維持し、旧URLを blog.kanouk.com へ転送してから、旧ロリポップを解約する」。追加修正では画像参照と添付の公開配信だけを扱う。旧サーバーのDNS・契約は変更していない。

## 今回取得した現在値

| 対象 | 確認結果 |
|---|---|
| 公開記事 | 1,370件すべて移行先に存在。公開状態を維持 |
| 下書き | 1件が非公開のまま存在。空の元タイトルは「無題」へ正規化 |
| 固定ページ | 3件すべて移行先に存在 |
| 本文 | WXRに存在する全投稿・固定ページの可視テキストは現在のWordPressと一致。WXR後の2投稿も保存済みREST deltaと本文・タイトルが一致 |
| コメント | 65件すべて存在。改行・HTMLを既存移行規則で正規化後、本文・公開状態・親コメント・記事の紐付けに差分なし |
| 分類 | 全投稿のカテゴリー・タグ割当の欠落0 |
| 添付 | 1,362件すべて、現在の旧WordPressから取得したbyteと現在のR2から読み戻したbyteのSHA-256が一致 |
| 添付サイズ | 合計482,057,235 bytes。重複排除後の移行先ファイルは1,318件 |
| 形式 | PNG 481、JPEG 815、WebP 6、SVG 1、GIF 54、Excel 3、PDF 1、MP3 1 |
| 商品・再利用ブロック | Pochipp 590件、再利用ブロック3件を現在の管理者RESTで保全。本文の可視テキストは元WXRと一致 |
| メニュー | 10項目・2メニューをREST snapshotへ保全。新サイトのナビゲーションは別設計 |
| クイズ | 現在の公開画面を複数回取得し、ランダム出題される計12問の問題・選択肢・正解・解説が保存済みquiz snapshotと一致 |
| 移行先DB | 現在のD1を約59.5MBのSQLへ保全。sha256: a72d4a6ecf038cd9028f9e08d16ce8a830dc3ecd8e7ced255e6edd081a7cba64 |

旧本文と新Portable Textも全件比較した。香水記事1件は移行後に香水DBへのカードと新しい画像へ編集済みであり、元本文へ巻き戻さない。Excelのリンク表示名はファイル名へ変換済み。商品カード3記事の短い差分はshortcodeの展開であり、本文欠落ではない。

## 停止前に必要な修正

### 1. 旧画像URL

公開記事15件の画像関連フィールドに残っていた旧WordPressのURLを26箇所修正した。うち本文内は5記事・13箇所、アイキャッチは13記事・13箇所（対象記事に重複あり）。元ファイルと移行先ファイルはすべてbyte一致を確認済み。

`proposed-media-repairs.json` に既存の公開revision、before/after、26箇所の変更、attachment ID、media ID、SHA-256を保全した。既存の未公開下書きがないことを確認し、API適用時も変更競合・新たな下書きがあれば停止する。2026-10-22に15記事・26箇所のAPI適用と公開readbackを完了した。本文とアイキャッチ以外のコンテンツフィールド、作成・公開日時、slug、執筆者、locale、SEOは不変。アイキャッチ13件はCMS 1.3の標準正規化に合わせ、参照先の画像ID・寸法・storage keyまで独立したmedia台帳と照合した。

適用時は既存の認証手順に従い、最小権限を使う。修正データは非公開の監査パッケージに保全した。

### 2. 添付ダウンロードの404

全公開crawlで、公開記事からリンクされるExcel 2件・PDF 1件が404だった。R2上のファイルは保存されており、原本とも一致する。Workerの公開media判定がPortable Textの`file.url`を認識していなかった。

修正は現行の公開revisionにある`file` blockの完全一致URLだけを公開参照として認識する。下書き・削除・古いrevision・別block内のURL・URLの部分一致・未確認写真の拒否を維持する。回帰テストを追加した。このPRに配信修正と回帰テストを含む。リリース後の公開ファイルGET/HEAD・原本hash・非公開ファイル拒否の結果は[PR #108](https://github.com/kanouk/kanouk.com/pull/108)へ記録する。

### 3. 転送

`kanolog-redirects-2026-10-22.csv` に、トップ＋公開記事1,370件＋固定ページ3件の計1,374件を用意した。転送先は現在の公開記事IDから生成しており、古いURL Mappingsのslug型URLをそのまま採用していない。未公開投稿は含まない。

これはcanonical URLの対応表であり、まだ公開転送設定ではない。実装時にはHTTP/HTTPS、www、末尾スラッシュ、`?p=ID`、feed、分類・アーカイブ、添付への導線を別途確認する。未知URLを一律トップへ転送しない。kanolog.net zoneは現在Cloudflareにはなく、nameserverはムームーDNSのまま。

## 全公開crawl

- sitemap掲載1,849ページと内部リンク2,275件を検査。
- 旧WordPress uploadsの出力は4記事・20出現（同じ画像の複数出力を含む）。保存データの旧URLは上記の15記事に残る。
- 別の残件として、SmugMugの旧URL出力が4記事、art-quiz.comへのリンクが1記事あった。これらをkanolog.netの画像消失と混同しない。
- 上記の添付ダウンロード3件以外の内部リンクstatusに失敗なし。
- `wordpress://`、Gutenberg comment、既知shortcode、plugin placeholderは0。
- 初回の代表検査は旧checkoutのresponsive画像形式を前提として停止した。最新checkoutはpreview-v2に対応済み。写真詳細のHTMLクラス判定を現行の`photo-page photo-viewer`に合わせ、リリース後のblog・photos・workers.dev代表検査がすべて合格した（Python 3.11、308転送追従）。

## 契約の取り下げ前に残る確認

旧ホスティング管理画面は緊急メンテナンス中で、同居サイト・メールボックス・旧DB/ファイル全体の最終保全は未確認。現在のDNSには旧サーバーへのMXがあるため、利用有無を確認する。ドメインは維持する。契約・請求・購入記録の詳細は非公開の監査記録だけに保存した。

## 非公開証拠と再開

原本と監査ログはGit管理外の非公開監査パッケージ（directory 0700、ファイル0600）に保存。下書き・コメント投稿者情報を含むためGitには追加しない。

主な証拠: `source-snapshot-manifest.json`、`content-summary.json`、`comments-taxonomies-comparison.json`、`media-verification.json`、`media-summary.json`、`quiz-comparison.json`、`public-crawl.json`、`proposed-media-repairs.json`、`destination-backup/`。原添付とR2 readbackの両方のbyteも保存した。

再開順序:

1. 15記事/26箇所のAPI適用・公開revision・他フィールド不変のreadbackは完了。公開15ページと画像原本24件も検証済み。修正専用tokenは取り消し、APIの401拒否とローカル秘密ファイルの削除を確認した。
2. ダウンロード公開判定はPR #108でリリース済み。公開記事のExcel 2件・PDF 1件はGET/HEADが200で原本byteと一致した。R2に原本が存在する公開参照なしのExcel 1件はGET/HEADとも404を維持した。
3. 修正対象だけ再検査する。新規の問題がなければ無関係な記事を再生成・再importしない。
4. メンテナンス終了後、旧契約の同居サイト・メール、旧DB/ファイルの最終保全を確認する。
5. サーバーから独立した301転送を実装し、DNS/TLS/代表URL・記事全件の転送先を検証する。
6. 転送の成立後にロリポップを契約満了で解約し、解約受付と満了日を読み戻す。ドメインは維持する。

## ローカル検証

- `test:migration`: 167件合格。
- `test:ux`: 108件合格。
- `typecheck`: 0 errors / 0 warnings / 1 hint。
- production build成功。既存のchunk size警告あり。

## 2026-10-22 画像参照の修正

対象15記事の26参照を、原本と一致する移行済みファイルへ更新・公開した。APIのrevision条件と保存後の一致を検査し、既存の下書きは更新しない。before/afterは非公開パッケージへ保全した。旧本文への再import、無関係な記事の再生成は行っていない。

PR #108のmerge commit `ae9a1ecbb54f226f69bc1918b2dcfaae890e628e`からbuild・deployし、Worker version `a102fad1-77db-4c54-8599-ec5644aba2d6`の100%配信をAPIで確認した。画像原本24件と添付3件のhash、公開15記事、参照なしファイルの拒否、token失効の証拠を非公開の`release-verification.json`へ保存した。tokenの秘密ファイルは削除済み。
