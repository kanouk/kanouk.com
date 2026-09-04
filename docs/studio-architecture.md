# Studio運用・互換性契約

Studioは、EmDash 0.35をCMS基盤として残したまま、記事・写真・アルバムの日常操作を用途別にまとめるネイティブ管理プラグインです。

```text
Studio UI
  -> Studio API / domain helpers
  -> EmDash admin API or plugin route
  -> EmDash validation, revisions, publish, media
  -> D1 / R2
```

StudioからD1/R2へ直接書き込みません。標準のEmDash管理画面は、スキーマ、Media、URL Mapping、復旧など高度な操作のために残します。

## 日常の入口

`/_emdash/admin/plugins/yohaku-photo-studio/` をStudioの入口とします。

- 記事: 日本語、投稿日=現在、著者=カノで下書きを作り、本文・画像・分類を編集して明示的に公開する
- 固定ページ: 一覧、検索、下書き作成、タイトル編集、本文・画像・SEO編集、公開をまとめる
- 写真: 50件単位の派生画像グリッドで探し、一覧を離れずにタイトル、キャプション、alt、撮影日、アルバムを編集する
- アルバム: 下書きを作り、最大20点を一度に追加し、撮影日順・ドラッグ・矢印で並べ、カバーと公開状態を設定する
- 要確認: メタデータ不足、位置情報、壊れた参照、変換失敗、未公開、孤立Media、SHA重複候補を確認する
- 高度な管理: MediaのSHA、状態、利用件数、全参照元を確認する。完全削除操作はStudioに置かない

写真のアップロードは、EmDashのMedia登録とPublic Photo下書き作成を一つの操作にまとめます。同一バイトはEmDashのcontent hashによる既存Media判定を利用します。Public Photoを別アルバムへ移す場合は再アップロードしません。アルバムから外す場合は「ストリーム」を移動先として選び、直前の移動を取り消せます。

記事だけで使うスクリーンショット・図・合成カバーは記事素材、独立した公開対象として残す写真はPublic Photoとして扱います。記事本文の既存ギャラリーとYohaku意味ブロック（吹き出し、商品情報など）はEmDash本文エディタで利用します。

## EmDash 0.35との境界

確認済みの正式な拡張点は、native pluginの`adminEntry`、`contentListColumns`、`contentEditorPanels`、plugin route/storageです。Studioは次を利用します。

- Content REST API: 一覧、取得、作成、`_rev`付き下書き更新、公開
- Media REST API: アップロード、SHA重複排除、`includeUsage=1`、個別usage
- plugin storage: 一括編集、アップロード、移動、並べ替え、位置情報除去の操作レシート
- 管理画面拡張: Public Photosの派生サムネイル、タイトル/キャプション、アルバム、要確認、状態/更新列と、Album内写真パネル

EmDash固有のresponse envelopeは`src/studio/api.ts`で吸収します。競合は409として扱い、無言で上書きしません。一括処理は各対象を最新`_rev`で再取得し、失敗分だけを選択状態に残します。

## 公開写真サイトの管理モード

ブログ管理ホストの認証Cookieを`.kanouk.com`へ広げません。

1. 認証済み管理者がブログ側で90秒のhandoff tokenを発行する
2. 写真ホストでtokenを交換し、30分のhost-only Cookieを発行する
3. 管理者が「管理モードをON」にした後だけ、下書きデータを取得する
4. 更新はフィールドallowlistと`_rev`を通し、公開ボタンまでは下書きに留める
5. 終了時に写真ホスト側セッションを破棄する

CookieはHttpOnly、HTTPSではSecure、SameSite=Laxです。handoff tokenとセッションIDは平文保存せずSHA-256 keyで保持します。使用済み・期限切れtokenは拒否します。管理セッションを持つ応答は`private, no-store`で、公開edge cacheへ入りません。匿名応答には管理UI、管理用JavaScript、下書きデータを含めません。

## 画像配信

表示派生は`320 / 480 / 768 / 1200 / 1600px`、AVIF/WebP、`scale-down`を既存の配信契約とします。Studioの一覧・アルバムパネル・公開管理モードは320px WebPを使い、原寸を一覧で取得しません。公開本文・カバー・詳細は`YohakuImage`の`srcset`を利用し、原寸は対応する表示またはダウンロードだけで取得します。変換URLはimmutable cache、管理・preview応答はprivate cacheです。

## 安全な位置情報除去

要確認キューは位置情報を持つ写真を候補として示すだけで、自動削除しません。実際の除去は`redact_photo_locations.py`を使い、JSON allowlistに列挙した写真だけを対象にします。既定はdry-runです。

```sh
python3 scripts/migration/redact_photo_locations.py \
  --allowlist /absolute/path/to/approved-photo-ids.json

python3 scripts/migration/redact_photo_locations.py \
  --allowlist /absolute/path/to/approved-photo-ids.json \
  --apply
```

allowlistの形式は`{"photo_ids":["..."]}`です。applyは次をfail-closedで検証します。

- exiftoolの`ImageDataHash`が処理前後で一致し、写真ピクセルが変わっていない
- 新しいMediaの埋め込みGPSが空
- CMSの緯度・経度・高度とsource metadata内のlocation/GPSが空
- 既に公開済みだった写真は再公開し、公開Mediaと公開ページを読み戻す
- 旧Mediaは削除せず保持し、操作レシートを残す

この運用ツールは認証情報で固定されたEmDash環境だけを操作し、D1へ直接書きません。対象ID、成功・失敗、操作IDを残し、失敗したIDだけのallowlistで安全に再開できます。

## 更新時の互換性ゲート

EmDash更新時は次を必須ゲートとします。

1. `npm run test:migration`（Studio domain/session/security/adapter contractを含む）
2. `npm run typecheck`
3. `npm run build`
4. Python安全性テスト
5. stagingでログアウト状態、管理状態、409、token再利用拒否、PC/モバイル、ライト/ダークを確認
6. productionで匿名HTML、cache、記事、アルバム、写真、responsive Mediaを読み戻す

API envelope、plugin admin exports、Content/Media endpoint、usage coverageのいずれかが変わった場合はfailさせ、EmDashのprivate内部実装へ追従するのではなくAdapterを更新します。usage coverageが`complete`でない場合、利用0件を安全な削除根拠にしません。
