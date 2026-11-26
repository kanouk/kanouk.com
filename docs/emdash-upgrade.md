# EmDash の更新とカスタマイズの構成

`apps/web` は EmDash（現在 1.6.0、`package.json` で完全固定）を使う。管理画面の使い勝手は、次の 2 層に分けて実装している。

1. **拡張ポイント層**（`apps/web/scripts/emdash-admin/`）: EmDash 管理画面に汎用の差し込み口だけを足す小さなパッチ。サイト固有の UI は置かない。
2. **プラグイン層**: 実際の振る舞い。信頼済みプラグインの管理画面モジュール（descriptor の `adminEntry`）が拡張ポイントを使う。
   - `apps/web/plugins/yohaku-content-blocks/src/admin/`: ブロック挿入ダイアログ、挿入済みブロックの表示、挿入時の既定値。
   - `apps/web/src/studio/admin.tsx`: 関連アルバムなどの編集パネル、写真整理ページ。

EmDash 本体に同等の機能が入った拡張ポイントは削除し、プラグイン側は公式 API へ移す。拡張ポイント層が小さいほど更新は楽になる。

## 拡張ポイント一覧

| id | 内容 | プラグイン側の API | 上流への提案 |
| --- | --- | --- | --- |
| `block-editor-runtime` | 信頼済みプラグインの `blockEditorExtensions` を集める | `export const blockEditorExtensions = [...]` | ブロック用フックの公式化 |
| `block-kit-dependent-select` | Block Kit select の `depends_on` / `clear_fields` / 選択肢の `values`、読込エラー表示、セレクト下のアドオン | フィールド定義、`useModal().fieldAddon` | Block Kit への追加 |
| `block-modal-extensions` | ブロック挿入・編集ダイアログ: 前後のプレビュー、フィールド変換、送信可否、`defaultValues` | `useModal(ctx)` → `{ onOpen, before, after, canSubmit, transformField, fieldAddon }` | ダイアログ用フック |
| `block-insert-defaults` | スラッシュメニューからの挿入時の既定値。記事の下書き（`documentData`）を参照可能 | `insertDefaults({ block, editor, insertPos, documentData })` | 挿入時フック |
| `block-node-view-extensions` | 挿入済みブロックのサムネイル、タイトル、コピー／開く URL、下部プレビュー | `nodeView({ blockType, id, data })` → `{ imageUrl, imageReferrerPolicy, title, externalUrl, below }` | ノード表示フック |
| `editor-panels-draft-access` | 信頼済み編集パネルを新規記事にも表示し、下書きの読み書きを許可 | `contentEditorPanels` の `supportsNew`、`draftData`、`onFieldChange` | 0.40 では sandboxed パネルのみ対応。trusted への拡張を提案 |
| `image-presentation-attrs` | 画像ブロックの `visualStyle` を保持し、ツールバーと画像プレビューに拡張を表示 | `ImageToolbar`、`imagePreviewClass` | 属性の保持と画像編集フック |

API の詳細は `apps/web/scripts/emdash-admin/patches/block-editor-runtime.mjs` の冒頭コメントを参照。

パッチを使わず、公式 API だけで差し込んでいるもの:

- 記事のアイキャッチ画像欄（`posts.featured_image` の widget `yohaku-photo-tools:featured-image-compact`）。`@emdash-cms/admin` が公開する `MediaPickerModal` を使い、本文の上に1行の欄として表示する。保存する値は本体の `mediaItemToImageFieldValue` と同じ形にそろえている（`apps/web/src/studio/admin.tsx` の `imageFieldValueFromMedia`）。更新時は、本体のこの関数の形が変わっていないかを確認する。
- 記事編集画面の項目の順序（タイトル → アイキャッチ → 本文 → 抜粋。抜粋は一覧・RSS・共有用の説明文で、記事ページには表示しない）と抜粋の行数（3行）。スキーマの設定で変える。D1 をバックアップしてから、管理者として既存の記事を開き、右の「編集画面の並び」の「編集画面の並びを整える」を押す（設定が済むとこの欄は出なくなる）。有効な管理者トークンがあれば `python3 scripts/cloudflare/run_post_editor_layout_kanouk.py` でも適用できる（`--apply --backup-manifest … --receipt …`）。

0.35 からの移行で削除したもの:

- 公開ページ URL の `{id}` 置換: 0.40 で本体が対応した。
- 画像リンク `link` の保持: 0.40 で本体が `{ href, blank? }` として対応した。公開側の `YohakuPortableImage.astro` は、旧形式の文字列と新形式の両方を描画する。

## 更新手順

Dependabot（`.github/dependabot.yml`）が、EmDash 関連パッケージをまとめた PR を週 1 回作る。CI（Verify Yohaku）は `npm ci` の postinstall で拡張ポイントを適用し直す。そのため、アンカーがずれると CI の時点で失敗する。

手元で更新するとき:

```bash
cd apps/web
npm install --ignore-scripts --save-exact emdash@<version> @emdash-cms/cloudflare@<version>
npm run emdash-admin:check        # 拡張ポイントが新しいバンドルに当たるか確認
node scripts/emdash-admin/apply.mjs
npm run test:migration && npm run test:ux && npm run typecheck && npm run build && npm run test:performance-build
```

`emdash-admin:check` が失敗したら、エラーに出る id の拡張ポイントを見直す。

1. 上流の該当コードを `node_modules/@emdash-cms/admin/dist/App-<hash>.js.pristine` で確認する（適用前の原本）。1.5 までは `dist/index.js.pristine`。
2. 上流に同等の機能が入っていれば、そのパッチを `registry.mjs` から外して削除し、プラグイン側を公式 API に移す。
3. 入っていなければ、アンカーを新しいコードに合わせる。汎用の差し込み口だけを保ち、サイト固有の処理はプラグインに置く。
4. `registry.mjs` の `VERIFIED_ADMIN_VERSION` を更新する。

ビルド時の変換（`scripts/lazy-admin-blocks.mjs`、`scripts/direct-phosphor-imports.mjs`）も、上流の import 形が変わると失敗する。0.40 では、アイコンの名前空間 import を使っている 18 個だけに絞っている（`docs/performance/README.md`）。

## デプロイ時の DB マイグレーション

EmDash の既定設定（`migrations.runtime: "auto"`）では、新しい Worker が最初のリクエストを受けた時点で、未適用の D1 マイグレーションが自動で実行される。0.35.0 から 0.40.1 への更新では、`071_restore_content_bylines_table` から `085_taxonomy_def_groups` までの 15 本が追加された（`079_datetime_normalization` などデータを書き換えるものを含む）。

- デプロイ前に D1 のバックアップ（Time Travel の復元点の確認、または export）を取る。
- `bun run migrate:status` で未適用のマイグレーションを確認し、必要なら運用手順どおり fingerprint を指定して先に適用する。
- ローカルでは、0.35.0 で作ったデータ入りの D1 に 0.40.1 を起動し、15 本が自動適用されること、記事・写真・関連アルバム・ブロックがそのまま開けることを確認した（2026-09-26）。

### 1.0.1 への更新（2026-09-28）

0.40.1 から 1.0.1 への更新では、7 本の拡張ポイントとビルド時の変換がすべて変更なしで適用できた。1.0 にも同等の公式 API はまだないため、拡張ポイントは引き続き必要。

マイグレーションは 4 本（`086_relations_structural`〜`089_auto_seed_completion`）追加された。`087_reference_field_relations` は、古い参照項目をリレーション（`_emdash_content_references`）に移し、移した項目の元の列は以後読まれなくなる。ただし `indexed` または `searchable` の項目は移行しない。`posts.related_album` と `photos.album` はどちらも `indexed: true` のため対象外で、列を直接読む SQL（`src/utils/*`、`src/studio/photo-read.ts`）はそのまま使える。デプロイ前に、本番 D1 でも両項目の `indexed` が 1 であることを確認すること。

```bash
python3 scripts/cloudflare/check_emdash_reference_fields.py --remote
```

このチェックは、087 がリレーションへ移す参照項目が 1 つでもある場合と、`photos.album` / `posts.related_album` がインデックス付きの列として残らない場合に、終了コード 1 で止まる。ローカルでインデックスを外した D1 に対して実行し、止まることを確認した。

ローカルでは、0.40.1 のデータ入り D1 に 1.0.1 を起動し、4 本が自動適用されること、移行されたリンクが 0 件であること、編集シナリオが 0.40.1 と同じ結果になることを確認した。

### 1.1.0 への更新（2026-10-02）

1.0.1 から 1.1.0 への更新でも、7 本の拡張ポイントとビルド時の変換は変更なしで適用できた。同等の公式 API はまだない。

追加のマイグレーションは 2 本で、どちらもリダイレクト機能用。

- `090_redirect_enable_loop_guard`: 無効なリダイレクトを有効に戻すとき、ループになるなら拒否するトリガーを追加する。既存データは書き換えない。
- `091_redirect_artifacts`: リダイレクト照合用の事前計算テーブルとトリガー。古い場合は `_emdash_redirects` を直接読み、後から作り直す。

`086`〜`089` の内容は 1.0.1 と同じ。0.40.1 の本番 D1 に 1.1.0 をデプロイすると、`086`〜`091` の 6 本が適用される。上の参照項目チェックは 1.1.0 でもそのまま使う。

ローカルでは、0.40.1 のデータ入り D1 に 1.1.0 を起動し、6 本が自動適用されること、移行されたリンクが 0 件であること、編集シナリオが 0.40.1・1.0.1 と同じ結果になること、旧記事と画像リンクがそのまま開けることを確認した。

管理画面の初期 JS は 1,212,120 bytes（gzip）になった。内訳と予算の変更は `docs/performance/README.md` を参照。1.1.0 で追加された HTML ブロック用のコードエディタ（CodeMirror）は遅延読み込み。

### 1.6.0 への更新（2026-11-24）

`emdash` と `@emdash-cms/cloudflare` を 1.6.0、Forms を 0.2.14 に更新した。1.6 の管理画面と Forms は、どちらも `@cloudflare/kumo` 2.19.0 を必要とする。1.5.0 のときと同じく、`npm install` はロックファイルに残った旧版と peer dependency がぶつかって ERESOLVE で止まった。そのため、ロックファイルから EmDash 関連・kumo・TipTap の項目を外して解決し直した。TipTap は 3.32.0 のまま。`bun.lock` は `bun install --lockfile-only` で同期した。

**管理画面の配布ファイルの構成が変わった。**

- 本体が `dist/index.js` から `dist/App-<hash>.js` に移り、`index.js` はそれを読み直すだけの約 9KB のファイルになった。
- 拡張ポイントの適用先（`apply.mjs` の `adminPackagePaths`）と、ビルド時の変換（`scripts/lazy-admin-blocks.mjs`）の対象を `App-<hash>.js` に変えた。原本は `App-<hash>.js.pristine` に置く。
- 1.5 の共有チャンク `convert-<hash>.js` は `schema-<hash>.js` に名前が変わった。`image-presentation-attrs` のチャンク名も `schema` にした。

**拡張ポイント**は 7 本とも引き続き必要。合わせ直したのは `editor-panels-draft-access` の 1 本だけで、ほかの 6 本は場所が変わっただけで、そのまま当たった。

- 1.6 は信頼済みパネルに公式の `editorDraft`（下書きの読み取りと書き換え）を渡すようになった。ただし保存済みの記事だけで、新規記事ではパネル自体が出ない。そのため、新規記事でパネルを出して `draftData` と `onFieldChange` を渡す拡張は残し、公式の `editorDraft` もそのまま渡す。
- 1.6 の `isVisible` によるパネルの表示判定は、`isVisible` を持たないパネルを常に表示する。このサイトのパネルは `isVisible` を使っていないので、新規記事でも表示される。

**マイグレーション**は 1 本（`098_user_last_login`）。`users` に `last_login_at` 列を足すだけで、既存の行は書き換えない。本番の未適用は 098 だけだった。デプロイ前に D1 Time Travel の復元点を記録した（2026-11-23T23:02Z、bookmark `000004eb-00000104-0000512c-b831b99d3be9475077d098b42f3ac856`）。

**このサイトへの影響を確認したこと**

- 画像の元ファイル（`/_emdash/api/media/file/`）の 1 年キャッシュ：`cacheCloudflare()` を使っているので対象になる。ただし `src/middleware.ts` が `/_emdash/` 以下の応答で最後に `context.cache.set(false)` を呼ぶ。Astro は最後の指定を使うので、画像は共有キャッシュに入らない。下書き画像の非公開はこれまでどおり。`/_image` の変換キャッシュは、`imageService: "passthrough"` なので対象外。
- 記事が見つからないときの 404 キャッシュ：このサイトは `/404` への rewrite ではなく redirect なので、挙動は変わらない。
- 検索スコアの正規化：スコアの値を使う処理はない。
- 同じ `getEmDashEntry()` の結果の共有：取得したデータを書き換える処理はない。
- 予約公開：`createScheduledHandler()` を使っているので、1.6 の待ち合わせ（最大 70 秒）が自動で効く。

Node 24.21.0 で、拡張ポイントの適用確認、移行・管理機能テスト 169 件、公開 UX テスト 185 件、Python テスト 191 件、型チェック（エラー・警告 0）、ビルド、サイズ予算チェックが合格した。管理画面の初期 JS は 1,333,304 bytes（gzip）、管理画面 CSS は 48,389 bytes、公開 CSS は 31,245 bytes。

097 まで適用済みのローカル D1 に 1.6.0 を起動し、098 が自動で適用されることを確認した。ローカルの架空データで、次の動作を確かめた。

- 公開ページ（トップ、記事一覧、記事、アーカイブ、トピック、検索、カテゴリー、写真サイトのトップ・アルバム・検索）
- 新規記事での関連アルバムのパネル
- 「アルバムの写真」ブロック：関連アルバムが既定値として入る、写真の選択肢とサムネイルが出る、写真を選ぶとキャプション・代替テキストが入る、挿入後の表示、下書き保存（関連アルバムとブロックの内容が保存される）
- 写真整理画面のアルバム一覧

**デプロイ後にすること**：1.6 は本文中のリンクからメディアの「使用箇所」を数えるようになったが、既存の記事は自動では数え直されない。必要なら管理者として `npx emdash media repair-usage --all` を一度実行する（未実施）。

### 1.5.0 への更新（2026-11-16）

`emdash` と `@emdash-cms/cloudflare` を 1.5.0、Forms を 0.2.13 に更新した。1.5 の管理画面と Forms は、どちらも `@cloudflare/kumo` 2.15.0 を必要とする。`npm install <pkg>@1.5.0` は、ロックファイルに残った 1.4.0 の記録と peer dependency がぶつかり ERESOLVE で止まった。そのため、ロックファイルから EmDash 関連と TipTap の項目を外して解決し直した。TipTap は EmDash が固定する 3.32.0 に揃えている（1.4.0 のときは 3.32.2 が混在していた）。`bun.lock` は `bun install --lockfile-only` で同期した。

**マイグレーション**は6本追加された（`092`〜`097`）。

- `092_plugin_kv_options`: sandboxed プラグインの KV（`_plugin_storage` の `__kv`）を `options` に複製する。本番は該当 0 件。写真の並び順（`settings` コレクション）は対象外で、元の行も消えない。
- `093_menu_item_orphans`: 親のないメニュー項目を最上位へ移す。本番は該当 0 件。
- `094_media_usage_file_url_reindex`: 本文中のメディアの「使用箇所」を作り直す予約だけをする。
- `095_plugin_storage_unique_scope`: プラグイン保存領域の一意インデックスを作り直す。本番は Forms の `slug` だけで、行は 0 件。
- `096_revision_kind_and_editors`: `revisions` に `kind` と `edited_by` を追加する。既存の行はどちらも NULL のまま。
- `097_room_storage`: 共同編集用のテーブルを作る。共同編集（`coEditing`）は使っていない。

このバージョンのマイグレーションを適用すると、それ以前の EmDash からはサイトの書き出し・取り込みができなくなる。デプロイ前に D1 Time Travel の復元点を記録した（2026-11-15T15:15Z、bookmark `000004c5-00000e96-00005124-1cc3ebca4ba8064ee347ce2e09d59cf9`）。

**管理画面の拡張ポイント**は 7 本とも引き続き必要。1.5 で上流が大きく変わったため、5 本を合わせ直した。

- `block-kit-dependent-select`: `BlockKitField` に `errorId` が増えた。
- `block-modal-extensions`: ブロックのダイアログが `LayerDialog` と入力チェック（`pluginBlockProblems`）に作り直された。前後のプレビュー、項目の変換、選択肢の下の補助表示を新しい構造に差し込む。`canSubmit` がなくなったため、プラグインの送信可否は挿入ボタンの `disabled` と送信処理の両方で効かせる。
- `block-insert-defaults`: エディターが共同編集に対応し、挿入位置が `{ position }` のオブジェクトに、編集中のブロックが位置ではなくブロックそのものになった。本文エディターは 2 か所で描画されるため、どちらにも `documentData` を渡す。
- `editor-panels-draft-access`: プラグインのパネルが「エディターのセクション」（`resolveEditorExtensionSections`）として扱われるようになった。新規記事では、`supportsNew` の trusted パネルだけを残す。設定パネルは `RoomContentSettingsPanel` 経由で描画されるため、下書きの受け渡しもそこで行う。
- `image-presentation-attrs`: 画像のスキーマと Portable Text の変換が共有チャンク `dist/convert-<hash>.js` に移った。拡張ポイントの仕組みを、`index.js` 以外のチャンクも同じ手順（`.pristine` から適用）で書き換えられるようにした（パッチの `chunks: { convert(editor) {} }`）。

`scripts/legacy-article-rendering.test.mjs` は、管理画面のバンドルから変換関数を切り出す方式をやめ、パッチ済みの convert チャンクを ES モジュールとしてそのまま読み込んで確かめる。1.5 の Worker の `fetch` は Promise を返さないことがあるため、`src/worker.ts` の呼び出しを `async` で包んだ。

Node 22（CI と同じ）でクリーンな `npm ci`、拡張ポイントの適用確認、移行・管理機能テスト 169 件、公開 UX テスト 135 件、Python テスト 191 件、型チェック（エラー・警告 0）、ビルド、サイズ予算チェックが合格した。管理画面の初期 JS は 1,321,563 bytes（gzip）、管理画面 CSS は 48,747 bytes、公開 CSS は 28,432 bytes。

091 まで適用済みのローカル D1 に 1.5.0 を起動し、6 本が自動で適用されることを確認した。ローカルの架空データで、次の動作を確かめた。

- 公開ページ（トップ、アルバム、写真、写真検索、記事一覧、アーカイブ）
- 新規記事での関連アルバムのパネル
- 「アルバムの写真」ブロック：関連アルバムが既定値として入る、アルバムに連動して写真の選択肢と補助表示が出る、写真を選ぶとキャプション・代替テキスト・画像が入る、挿入後の表示、下書き保存
- 写真整理画面（アルバム、ライブラリ、アルバムの並び順）

### 1.4.0 への更新（2026-11-01）

`emdash` と `@emdash-cms/cloudflare` を 1.4.0、Forms を 0.2.12 に更新した。npm と Bun のロックファイルを同期し、TipTap 本体と標準拡張は `extension-code-block-lowlight` の上流固定版 3.20.0 を除いて 3.32.2 に揃えた。旧ロックファイルの混在により subscript / superscript と core / pm の peer dependency が不整合になったため、TipTap の依存解決を更新している（別系統の `y-tiptap` は 3.0.12）。

1.3.0 と 1.4.0 の配布パッケージを比較し、番号付きマイグレーション 90 ファイルがすべて同一であることを確認した。追加・削除・変更はなく、最新は `091_redirect_artifacts` のまま。

管理画面の拡張ポイントは 7 本とも引き続き必要で、次の 3 本のアンカーを調整した。上流の修正は保持している。

- `block-kit-dependent-select`: `useId()` と `aria-labelledby` によるラベルの関連付け。
- `block-insert-defaults`: `EMPTY_PLUGIN_BLOCKS` による既定値の参照の安定化。
- `block-node-view-extensions`: URL を持たない未登録ブロックの URL 編集を防ぐ `canEditUrl` 判定。

1.4.0 は `cacheHint.lastModified` と自動の `Last-Modified` ヘッダーを廃止した。このサイトはどちらも参照しておらず、公開ページのキャッシュ期間は `astro.config.mjs` の route rules、認証・プレビューの除外は middleware が設定している。sandboxed plugin の呼び出し寿命の変更も、このサイトの trusted plugin 構成には該当しない。詳細は[公式リリースノート](https://www.emdashcms.com/blog/emdash-1-4)を参照。

Node 24.21.0 でクリーンな `npm ci`、拡張ポイントの適用確認、移行・管理機能テスト 167 件、公開 UX テスト 114 件、Python テスト 187 件、型チェック、ビルド、サイズ予算チェックが合格した。型チェックはエラー・警告 0、既存の `admin-bar.ts` に hint 1 件。管理画面の初期 JS は 1,238,249 bytes（gzip）、管理画面 CSS は 41,658 bytes、公開 CSS は 25,499 bytes。

新規のローカル D1/R2 では、トップページ 200・管理画面 302、記事の保存・再取得・公開、関連アルバムの解除、古いリビジョンの保存拒否、画像アップロードを確認した。下書き画像は匿名アクセス 404、認証済みアクセス 200 / private・no-store、未審査写真の公開は 409 だった。本番反映と管理画面の目視操作確認は、このローカル検証には含まない。

### 1.3.0 への更新（2026-10-17）

1.2.0 から 1.3.0 への更新でも、追加のマイグレーションはない（最新は `091_redirect_artifacts` のまま）。本番 D1 の未適用は 0 件。`@emdash-cms/plugin-forms` も 0.2.10 に上げた。

拡張ポイントは 7 本とも引き続き必要。`editor-panels-draft-access` だけ、上流の JSX が 1 段深くなったためアンカーのインデントを 1 タブ増やした。

1.3.0 の主な変更（このサイトへの影響なし）：リビジョン履歴の差分表示、ビジュアル編集の画像ツール、`robots.txt` で AI 学習クローラーを拒否する設定（Settings > SEO）、ルートキャッシュとリダイレクトの整合の修正など。

管理画面の初期 JS は 1,228,555 bytes（gzip）、CSS は 69,569 bytes で、どちらも予算（1,250,000／70,000）の 98〜99%。次の更新で予算を超えたら、内訳を見て予算か読み込み方を見直す。

### 1.2.0 への更新（2026-10-07）

1.1.0 から 1.2.0 への更新では、追加のマイグレーションはない（最新は 1.1.0 と同じ `091_redirect_artifacts`）。

拡張ポイントは 7 本とも引き続き必要（同等の公式 API はまだない）。3 本はアンカーだけ合わせた。

- `block-insert-defaults`、`editor-panels-draft-access`: 上流の JSX が 1 段深くなり、インデントが 1 タブ増えた。内容は同じ。
- `block-node-view-extensions`: 上流のブロック表示名のフォールバックが、文字列に加えて有限の数値も並べるようになった。新しい式をそのまま残し、プラグインの `title` を優先する点だけ差し込む。

`scripts/legacy-article-rendering.test.mjs` は、管理画面のバンドルから Portable Text の変換関数を切り出して実行する。1.2.0 ではその範囲に TipTap の `StarterKit.extend(...)` が入ったため、テスト側で `StarterKit` を差し替えた。

1.2.0 の変更のうち、このサイトに関係するもの:

- 本文に組み込みの `video` ブロックが入った。`yohaku-content-blocks` には `video` という型のブロックはないため、衝突はない。
- 標準の `Comments` が、コメントの日付をページのロケール（`ja`）で表示するようになった（以前は `en-US` 固定）。表示は「2026年10月7日 9:05」の形で、サイトの `yyyy/MM/dd` とは異なる。見出しや「Like」などの文言は、`labels` を渡さない限り英語のまま。
- 管理画面のコレクション一覧がページ番号付きになった。写真整理が使うカーソル方式の API はそのまま。
- 管理画面の初期 JS は 1,191,978 bytes（gzip）で、1.1.0 から少し減った。

## 0.40.1 で確認した挙動差

- 管理画面の初期 JS は、上流自体の増加で 794KB から 1,095KB（gzip）になった。予算を更新済み。
- 配布 CSS から `ring-kumo-brand/20` がなくなったため、写真サムネイルの選択枠は同じ色をインラインで指定している。
- ダイアログの幅、フォント、設定サイドバーの構成など、EmDash 本体の UI の変更はそのまま受け入れる。
