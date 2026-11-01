# EmDash更新記事の運用

2026-11-01に、ユーザーから「EmDashがバージョンアップされるたびに、ブログ記事としてあげてください。わかりやすく、わたしらしい文体で。カバー画像はEmDashのロゴで」と依頼された。

## 公開するタイミング

このブログへの適用後に、その版の記事を1本公開する。公式リリースの発表と、本番への適用は区別する。定期確認では本番の `https://blog.kanouk.com/_emdash/api/health` の `data.version` を確認し、未掲載の版があれば記事を作る。ソフトウェアの更新自体は、この定期確認の対象に含めない。

本番を更新する作業を担当したエージェントは、公開ページの検証が成功したあとで記事作成まで進める。毎日の定期確認は、別の作業で更新された場合の取りこぼしを補う。

このスレッドに毎朝9時（日本時間）の定期実行「EmDash更新記事の公開」を設定した（ID: `emdash`）。ローカルのファイルと認証を使うため、Macとデスクトップアプリが起動している時間に実行される。定期実行の設定方法は[OpenAI Docs](https://learn.chatgpt.com/docs/automations?surface=app)を参照。

起点は1.4.0。記録済みの最新の版より本番の版が古い場合は、ロールバックの可能性があるので新規記事を出さない。開発版・不明な版・ヘルスチェック失敗でも公開しない。

## 重複の確認

`content/emdash/published.json` を読み、その版の公開記事を認証APIで読み戻す。記録がなければ `emdash-<版のドットをハイフンにした文字列>` のslug（例 `emdash-1-4-0`）を、公開済み・下書きの両方で確認する。存在する場合は新規作成しない。通信・認証エラーを「記事なし」と扱わず、404と区別する。

公開直前にも同じslugを確認する。作成時にslugの重複が拒否された場合は既存記事を取得し、再作成しない。既存記事の編集リビジョンを勝手に公開しない。

## 書く内容

公式のリリースノートと、このサイトへの適用記録を読む。`style-profile.md` の傾向を下敷きに、必要なら最近の本人の公開記事を読み直す。

- タイトルと冒頭に、更新したEmDashの版を書く。
- 記事を書く・写真を扱うときに関係する変更を選び、何が起こるかを具体的に説明する。
- 一覧を逐語訳せず、変更の大きさに合わせて短く書く。小さな修正版に新機能を作らない。
- 公式の仕様説明、一般的な利用場面、このサイトで実際に確認したことを区別する。
- 知らない体験・気持ち・過去の不具合を、本人の体験として書かない。手動操作していない画面を「使ってみた」と書かない。
- メール、アカウントID、認証情報、内部の復旧情報、関係のない私的な記録は書かない。
- 公式リリースへのリンクを付ける。

本文は `content/emdash/<version>.md` に保存する。`explain-before-shorten` で説明の順序を整え、`yomiyasu` で推敲する。`natural-japanese` はクイックで検査する。yomiyasuの `run` と `verify` を実行し、指摘は資料と照合して判断する。校正の中間ファイルや検査記録は作業用ディレクトリへ保存し、記事本文や公開データに含めない。

## カバー

公式の原本: `https://www.emdashcms.com/brand/logo-dark-text.svg`。

`content/emdash/logo-dark-text.svg` が取得した原本、`content/emdash/cover.png` が白背景・1200×630のカバー。ロゴ自体の色・形・縦横比を変えず、余白だけを加えている。生成AIでロゴを描き直さない。

アップロード済みのMedia IDは `published.json` の `cover` に記録する。認証APIで存在を確認し、以後の版も同じ画像を再利用する。削除されている場合だけ再アップロードする。featured_imageにはMediaのID、公開URL、altを設定し、公開画面のカバーとOG画像を確認する。

## 認証とCMS操作

通常の移行トークンとは別の、記事登録専用トークンを使う。値はPrivate Vaultの `10_sensitive/api-keys/EmDash-kanouk-release-posts.md` にだけ保存する。内容とメディアの読み書き、スキーマの参照だけを許可し、admin・schema:writeは与えない。CLIのグローバルな認証ストアは使わない。

```sh
export PATH=/Users/kanouk/.anyenv/envs/nodenv/versions/24.21.0/bin:$PATH
python3 scripts/cloudflare/run_emdash_release_posts_kanouk.py schema get posts --json
python3 scripts/cloudflare/run_emdash_release_posts_kanouk.py content get posts emdash-1-4-0 --raw --locale ja --json
```

専用トークンが未作成・期限切れ・失効しているときだけ、次のコマンドで作成・更新する。既存のCloudflareアカウントガードと、固定した管理者行の確認を通す。別の認証へ切り替えたり、ガードを外したりしない。

```sh
python3 scripts/cloudflare/run_emdash_release_posts_kanouk.py --provision
```

まず `content create posts --draft --file <payload.json> --slug <slug> --locale ja --json` で下書きを作成する。`content` はMarkdown文字列で渡すとCLIがPortable Textへ変換する。本文先頭のH1はtitleへ分け、本文には重ねない。`published_on` は実際の公開時刻、`source_id` は `emdash-release:<version>`、`source_metadata` には種類 `emdash-release`・版・公式出典・適用の確認情報を記録する。

APIから下書きを読み戻し、検査済みの本文とカバーが一致することを確かめる。予定していない差分があれば公開しない。一致したら `content publish posts <id> --json` で公開する。公開後は同じレコードを `--published` で読み戻す。

## 公開後

`https://blog.kanouk.com/posts/<id>` でタイトル・本文・OG画像が正しいことを確認する。カバーはホーム・記事一覧のカードで確認し、元画像と配信用画像も読み戻す。著者は認証APIの所有者IDで確認する（公開ページでは著者欄を非表示にしている）。ホーム・記事一覧・RSSに追加されたことを確認し、キャッシュが古い場合は既存のキャッシュ無効化経路を調べる。確認せずに「公開済み」と報告しない。

`published.json` に版・slug・記事ID・公開URL・本文SHA-256・公開時刻・出典を追記する。本文、表紙原本、記録、運用変更をコミットしてPRを作り、必要なCIを確認してmainへ反映する。CMSへの記事登録にアプリの再デプロイは不要。
