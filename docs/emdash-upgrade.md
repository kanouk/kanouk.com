# EmDash の更新とカスタマイズの構成

`apps/web` は EmDash（現在 1.0.1、`package.json` で完全固定）を使う。管理画面の使い勝手は、次の 2 層に分けて実装している。

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
| `image-presentation-attrs` | 画像ブロックの `visualStyle` を保持 | なし | 未知属性の保持 |

API の詳細は `apps/web/scripts/emdash-admin/patches/block-editor-runtime.mjs` の冒頭コメントを参照。

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

1. 上流の該当コードを `node_modules/@emdash-cms/admin/dist/index.js.pristine` で確認する（適用前の原本）。
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

## 0.40.1 で確認した挙動差

- 管理画面の初期 JS は、上流自体の増加で 794KB から 1,095KB（gzip）になった。予算を更新済み。
- 配布 CSS から `ring-kumo-brand/20` がなくなったため、写真サムネイルの選択枠は同じ色をインラインで指定している。
- ダイアログの幅、フォント、設定サイドバーの構成など、EmDash 本体の UI の変更はそのまま受け入れる。
