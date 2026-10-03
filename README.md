# opencode-review

OpenCodeがリポジトリ固有のSkillに基づいてPRをレビューし、自前のCoreが指摘内容とコメント範囲を検証して、GitHubへinline review commentを投稿するGitHub Action。

**状態（2026-10-03）：Phase 0–6とMVP受け入れ（mvp-01〜08、8/8）まで実装・検証完了。git履歴はローカルmainにコミット済み、初回push前のためCI未実行。公開先・tag・ライセンスは未定（Q09）で、配布は別途依頼された段階で行う。** 検証の記録は[設計判断](docs/decisions.md)が正本。

## いま動くもの

- **Action本体**：`src/`の6モジュール（`finding` / `github` / `jev` / `main` / `opencode` / `range`）とv2 pluginテキストテンプレート（`templates/report-finding.plugin.ts`、`src/templates.ts`経由）。配布物は単一`dist/index.js`で、runtime依存はvalibot 1.5.0のみ（raw 137,271 B / gzip 32,449 B、bundleサイズゲート +0.00%）。
- **パイプライン**：OpenCode v2 producer（`report_finding` → NDJSON）→ Valibot検証 → Range Resolver → Jev（Zen `jev-1.13-free`）→ Publish Gate → inline投稿 / dry-run（POST 0回）。
- **検証状態**：`vp run typecheck` exit 0、unit/統合256件（Jev契約14件を含む）green、build再現性（2回buildのsha256一致）、Node 24 dist-only smoke、hosted E2E run 37081080875 attempt 3 成功（private scratch repo）。実inline投稿の実績はscratch PR #1のcomment 4168309537（単一行）・4168309817（複数行）。

## 到達レベル（証拠）

| レベル | 到達した内容 |
| --- | --- |
| 公式docs | `@opencode/cli@2.0.22`のv2 contract、Zen gateway、GitHub API version等の仕様確認 |
| fixture | 256 unit/統合（Jev契約14件を含む）。Tool入力・NDJSON・Range Resolver・Jev gate・publisherの境界 |
| ローカル実測（実モデル・匿名free） | `opencode/space-bunny-free`でcanary出現・`report_finding`取得・cleanupを実測。anchor先頭空白欠落で4/4 skip（既知の制約） |
| 実サービス（Jev Zen 匿名free） | `jev-1.13-free`で6例を校正。正例2/2合格・誤指摘2/2不合格、`too_wide`は検出限界 |
| 実機（GitHub Actions） | hosted E2E run 37081080875 attempt 3が成功（checkout・CLI導入・Review step完走。投稿0件は正常扱い） |

## できていない / 残っている

- 公開リポジトリ・tag・ライセンスは未定（Q09）。`examples/pr-review.yml`は`OWNER/opencode-review@<pinned-sha>`プレースホルダのまま。
- 初回push前のためCI（`.github/workflows/ci.yml`）は未実行。ローカルでは同等手順がgreen。
- 認証付き`jev-1.13`の実コールと閾値再校正は未実施。hosted実行の`review-result.json`はartifact未uploadで、counts / skip reasonをAPIから観測できない。
- 実モデルはanchorの先頭空白を落とすため、hosted実行は全finding skipになり得る（runは成功として扱う）。
- fork PR（標準tokenは読み取り専用・secretsなし）・LEFTコメント・過去レビューとの重複排除はMVP対象外（[ツール概要](docs/overview.md)）。

## 基本方針

- 1 Action invocation = 1 Skill = 1 OpenCode session。2 Skillは2 stepで独立に実行する。
- AIに自由文や独立したJSON文書を生成させず、v2 pluginのテキストテンプレートとJSON Schemaで定義した`report_finding` Toolへ値を渡させる（plugin / SDK / Zodはbundleへ取り込まない）。
- `report_finding`をFinding ProducerとReview Coreの唯一の結果受け渡し境界にする。
- Range Resolver → Jev Validator → Publish Gateを通過した1 findingを1 inline commentとして扱う。
- dry-runでも同じ検証を行い、GitHubへの投稿だけを無効にする。
- Action本体の実行時依存は原則Valibotのみ。bundleは単一`dist/index.js`。

## 使い方（最短）

[`examples/pr-review.yml`](examples/pr-review.yml)をコピーし、`uses:`を自分のリポジトリのcommit SHA固定へ置き換える。環境変数は`JEV_API_KEY`（必須。欠如は即run error、Actionプロセスのみが読み子プロセスへ渡さない）と`github-token`（既定`${{ github.token }}`）の2つ。無料モデル（`opencode/...`）はprovider key不要で、有料モデルへの自動fallbackはしない。

## 開発

開発環境は`vp`でNode **26.8.2**・pnpm **12.6.0**を固定する（[開発環境](docs/development.md)）。

```sh
vp run typecheck                    # strict TypeScript
vp run test                         # 256件（Jev契約14件を含む。Node標準runner）
vp env exec node --test test/jev/   # 上記Jev契約14件の単独実行
vp run build                        # dist/index.js + dist/metafile.json
vp run build:verify                 # 2回buildのsha256一致 + checked-in distとの一致
vp run bundle:check                 # docs/bundle-baseline.json に対するraw/gzip差分
bash test/smoke/dist-only-smoke.sh  # node:24-alpine + distのみの起動smoke（Docker）
```

`vp run test`は`test/`配下の`*.test.ts` / `*.test.mjs`を実行し、`test/live/*`（実ネットワーク・実CLI・実Docker・scratch PRを使うmanual seam）は対象外（一覧は[開発環境](docs/development.md)）。CI（`.github/workflows/ci.yml`）はtypecheck・全テスト・build再現性・bundleサイズ・two-skill分離・actionlint・dist-only smokeを実行する。

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [ツール概要](docs/overview.md) | 目的、MVPスコープ、利用イメージ、Action入出力 |
| [アーキテクチャ](docs/architecture.md) | 構成図・シーケンス、型、NDJSON、Range Resolver、Jev validator、publisher / dry-run、失敗と診断 |
| [実装計画](docs/implementation-plan.md) | フェーズ・成果物・完了条件（Phase 0–6 + MVP全完了） |
| [開発環境](docs/development.md) | Node 26・pnpm 12の固定、検証コマンド、CI、manual seam |
| [設計判断・未決事項](docs/decisions.md) | 採用方針、実測記録、Q01–Q10、残存依存 |
| [参照資料](docs/references.md) | 元会話と確認した公式仕様 |
| [AGENTS.md](AGENTS.md) | 最小限の英語のコーディング規約 |
