# opencode-review

OpenCodeがリポジトリ固有のSkillに基づいてPRをレビューし、自前のCoreが指摘内容とコメント範囲を検証して、GitHubへinline review commentを投稿するGitHub Action。

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
vp run test                         # 単体/統合テスト（Node標準runner）
vp env exec node --test test/jev/   # Jev契約テストの単独実行
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
| [実装計画](docs/implementation-plan.md) | フェーズ・成果物・完了条件 |
| [開発環境](docs/development.md) | Node 26・pnpm 12の固定、検証コマンド、CI、manual seam |
| [設計判断・未決事項](docs/decisions.md) | 採用方針、実測記録、Q01–Q10、残存依存 |
| [参照資料](docs/references.md) | 元会話と確認した公式仕様 |
| [AGENTS.md](AGENTS.md) | 最小限の英語のコーディング規約 |
