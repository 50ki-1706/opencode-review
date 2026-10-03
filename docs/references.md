# 参照資料

確認日：2026-10-02、v2追記：2026-10-03。公式仕様も変更されるため、実装時に使用versionとAPI仕様を再確認する。

## 元の会話

[PiでOpenCode Free利用](chatgpt-conversation://6abcb1a0-e49c-83e8-8e74-24e0c7271564)

ユーザーが添付した会話previewと`read_thread`で取得できた直近の会話を読んだ。取得結果には古い会話へ進むcursorがなく、会話全履歴を取得したとは扱わない。

確認できた設計の流れ：

1. AIに自由なJSONを出させず、定義済みToolへ値を埋めてもらう。
2. GitHub Actions、単一Skill、検証済みfindingのinline投稿に絞る。
3. OpenCode依存を整理し、`report_finding`を境界へ集約する。
4. TypeScriptを選び、CoreのschemaをValibotにする。
5. bundleサイズと複雑性を両立するため、SDKを除き、ToolテンプレートとNDJSONを使う。

会話内のアシスタントの提案は仕様の証明として使わず、以下の公式資料と、今後の互換性検証で確認する。

## 公式資料（2026-10-02、v1）

OpenCodeのv1項目は「v1 docs（v2移行で置換）」であり、v2の仕様は下の2026-10-03追記を参照する。Valibot・GitHub・TypeSafe・Vite+の項目は引き続き参照する。

| 資料 | 確認した事項 |
| --- | --- |
| [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)（v1 docs、v2移行で置換） | TypeScript / JavaScriptのTool、`.opencode/tools/`、`tool.schema`がZodであること |
| [OpenCode Agent Skills](https://opencode.ai/docs/skills/)（v1 docs、v2移行で置換） | Skill配置・frontmatter、名前規則、Skillごとのpermission |
| [OpenCode CLI](https://opencode.ai/docs/cli/)（v1 docs、v2移行で置換） | `opencode run`、model / agent指定、非対話実行 |
| [OpenCode GitHub](https://opencode.ai/docs/github/)（v1 docs、v2移行で置換） | 公式GitHub Action、pull_request実行、prompt / model / token設定 |
| [OpenCode Config](https://opencode.ai/docs/config/)（v1 docs、v2移行で置換） | 設定のmerge、custom config directory、共有無効化 |
| [OpenCode Permissions](https://opencode.ai/docs/permissions/)（v1 docs、v2移行で置換） | read / edit / bash / skill / taskの制約 |
| [OpenCode Zen](https://opencode.ai/docs/zen/) | 無料モデルの提供があること。モデル名・条件は固定しない |
| [Valibot Introduction](https://valibot.dev/guides/introduction/) | modular API、型推論、実行時validation、未使用コードの除去 |
| [GitHub Action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax) | node24、inputs / outputs、ハイフン付きinput環境変数 |
| [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) | pull_request / forkの権限・secret制約 |
| [GitHub review comments API](https://docs.github.com/en/rest/pulls/comments) | inline投稿endpoint、commit_id、line / side / start_line / start_side |
| [TypeSafe Introduction](https://docs.typesafe.ai/introduction) | Jevの型付き判断とNoul / Choice / Score |
| [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart) | HTTP endpoint、Bearer認証、questions / answersの対応 |
| [TypeSafe API reference](https://docs.typesafe.ai/api) | `POST /v1/systemone`、state / model / questions、応答型 |
| [Vite+ Environment](https://viteplus.dev/guide/env) | Nodeとpackage managerのproject pin、devEngines、環境確認 |

## 2026-10-03追記（v2 / 実サービス）

| 資料 | 確認した事項 |
| --- | --- |
| [v2 Plugins](https://opencode.ai/v2/docs/build/plugins) | pluginの`setup` / `ctx.tool.transform` / `editor.add`、JSON Schema入力、`options.codemode`、hooks |
| [v2 Config](https://opencode.ai/v2/docs/config) | configの場所とmerge、plugin指定、共有無効化 |
| [v2 Permissions](https://opencode.ai/v2/docs/permissions) | `permissions`配列、last match wins、`external_directory`の`/*`境界、既定policy |
| [v2 Skills](https://opencode.ai/v2/docs/skills) | Skill配置・frontmatter、Skill単位の権限 |
| [v2 Agents](https://opencode.ai/v2/docs/agents) | agent frontmatterの`permissions`、`mode`、`model` |
| [v2 CLI](https://opencode.ai/v2/docs/cli) | `opencode run`、`--standalone`（private server） |
| [OpenCode Zen](https://opencode.ai/docs/zen/) | `https://opencode.ai/zen/v1/systemone`、`jev-1.13-free`、Bearer |
| [TypeSafe API reference](https://docs.typesafe.ai/api) | `POST /v1/systemone`、state / model / questions、応答型、status |
| [TypeSafe Models](https://docs.typesafe.ai/models) | model idとalias、context・rate制限 |
| [TypeSafe Primitives](https://docs.typesafe.ai/primitives/noul) | Noul / Choice / Scoreの型と応答フィールド |
| [GitHub Action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax) | `runs.using: node24` |
| [GitHub review comments API](https://docs.github.com/en/rest/pulls/comments) | inline投稿endpoint、`commit_id`、`line` / `side` |
| [Vite+ Environment](https://viteplus.dev/guide/env) | Node / package managerのpin |

実サービス確認（2026-10-02〜03）: Zen経由の`jev-1.13-free`で匿名200と3判断の返却を取得。401 / 422のenvelopeと`cost`フィールドを`test/jev/fixtures/`へ保存した。

TypeSafe AIのJevを検証器の接続先として確定した（2026-10-03、公式docsと実サービスで確認）。架空のJev SDKや汎用レビューendpointは前提にしない。
