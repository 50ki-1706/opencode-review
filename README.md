# opencode-review

OpenCodeがリポジトリ固有のSkillに基づいてPRをレビューし、自前のCoreが指摘内容とコメント範囲を検証して、GitHubへinline review commentを投稿するGitHub Action。

**状態（2026-10-03）：Phase 0–6とMVP受け入れ監査まで実装・検証済み（mvp-02〜08は監査完了、詳細は`docs/decisions.md`「MVP受け入れ（2026-10-03）」）。hosted E2E（scratch repo PR #2、run 37081080875）はActions secret `JEV_API_KEY`の設定待ちで、設定後のrerunで完走確認する。** 公開先・バージョン戦略・ライセンスは配布作業時に確定する（未決事項Q09）。`examples/pr-review.yml`の`uses:`は意図的にプレースホルダのままで、実在する配布Actionを示していない。検証結果は`docs/decisions.md`と`.opencode/context/implementation-todo.json`に記録する。

## 基本方針

- 1 Action invocation = 1 Skill = 1 OpenCode session。2 Skillは2 stepで独立に実行する。
- AIには独立したJSON文書を生成させず、定義済みの`report_finding` Toolへ値を渡させる。
- `report_finding`をFinding ProducerとReview Coreの唯一の結果受け渡し境界にする。
- Range Resolver → Jev Validator → Publish Gateを通過した1 findingを1 inline commentとして扱う。
- `dry-run`でも同じ検証を行い、GitHubへの投稿だけを無効にする。
- Action本体の実行時依存は原則Valibotのみ。bundleは単一`dist/index.js`。

## 利用方法

### サンプルworkflow

[`examples/pr-review.yml`](examples/pr-review.yml)をそのままコピーして使う。要点：

| 項目 | 内容 |
| --- | --- |
| イベント | `pull_request`の`opened` / `synchronize` / `reopened` / `ready_for_review` |
| 実行条件 | draftでない、かつ `head.repo.full_name == github.repository`（同一リポジトリPRのみ） |
| 権限 | `contents: read` / `pull-requests: write` |
| 同時実行 | PR番号単位のconcurrency groupでcancel-in-progress |
| checkout | `ref: ${{ github.event.pull_request.head.sha }}`、`fetch-depth: 0`、`persist-credentials: false` |
| runtime | `npm install -g @opencode/cli@2.0.22` |
| Action | `uses: OWNER/opencode-review@<pinned-sha>`（プレースホルダ。commit SHA固定を推奨） |
| secret | `env: JEV_API_KEY: ${{ secrets.JEV_API_KEY }}` |
| 2 Skill例 | 同じjob内に独立したstepを2つ置く（各stepが別session・別result file） |

**公開先が未公開である理由とプレースホルダ維持**：リポジトリの公開先、version/tagの運用、ライセンスは配布時に確定する（Q09）。確定するまでは実在しない参照を書かないため`OWNER/opencode-review@<pinned-sha>`のままにする。自前ホストで試す場合は、このリポジトリをcheckoutして`uses: ./`（scratchリポジトリでのhosted E2Eと同形）、または自身のリポジトリへ複製してSHA固定で参照する。

### 認証

| secret | 必須 | 内容 |
| --- | --- | --- |
| `JEV_API_KEY` | 必須 | TypeSafe Jev（System One）のキー。欠如はenvironment run errorで即停止し、匿名free経路へfallbackしない（D24）。Actionプロセスだけが読み、OpenCode子プロセスへは名前・値とも渡さない。子環境の値がこのsecretと衝突した場合もspawn前にrun errorにする。 |
| provider key | 任意 | 有料providerを使う場合のみ。無料モデル（`opencode/...`）は不要。許可リストにないsecretは子へ渡らない。 |
| `github-token` | 投稿・metadata読み取りに必須 | 既定は`${{ github.token }}`。子プロセスへは渡さない（`GITHUB_TOKEN` / `GH_TOKEN`は非継承）。 |

`model`は`provider/model`の自由入力で、特定モデルをコードへ固定しない。「OpenCode Free」は無料モデルを選ぶ方針であり、無料モデルが使えない場合に有料モデルへ自動切替しない（`docs/overview.md`）。

### 権限とfork制限

- 権限は`contents: read`と`pull-requests: write`のみ。metadata読み取りとinline comment投稿に限定する。
- **fork PRは対象外**。fork PRでは標準`github.token`が読み取り専用になり、`secrets`も渡らない。`pull_request_target`でPRのコードを実行する構成は採用しない（D25）。同一リポジトリPRのみを対象とする。

### dry-run

通常実行と同じ検証（Range Resolver・Jev・payload生成）を行い、POSTだけを0回にする。

workflowでの指定：

```yaml
      - name: Security review (dry-run)
        uses: OWNER/opencode-review@<pinned-sha>
        with:
          skill: security-review
          model: opencode/space-bunny-free
          dry-run: 'true'
          github-token: ${{ github.token }}
        env:
          JEV_API_KEY: ${{ secrets.JEV_API_KEY }}
```

INPUT環境変数での指定（Actionは`with:`を`INPUT_*`へ変換する。ハイフンはそのまま）：

```sh
INPUT_SKILL=off-by-one \
INPUT_MODEL=opencode/space-bunny-free \
INPUT_DRY-RUN=true \
INPUT_GITHUB-TOKEN="$(gh auth token)" \
INPUT_JEV-MODEL=jev-1.13-free \
JEV_API_KEY=... \
GITHUB_EVENT_PATH=/path/to/event.json \
RUNNER_TEMP=/path/to/runner-temp \
GITHUB_OUTPUT=/path/to/output.txt \
GITHUB_REPOSITORY=owner/repo \
GITHUB_WORKSPACE=/path/to/head-checkout \
node dist/index.js
```

`test/live/phase5-live.mjs`はこの環境変数契約とscratch PRを使う動作中の例（認証前提は`docs/development.md`）。

### 失敗時の結果確認

#### outputs

| output | 内容 |
| --- | --- |
| `accepted-count` | Tool経由でCoreが受理したfinding数 |
| `publishable-count` | 検証を通り投稿対象になった数（dedup後） |
| `published-count` | 実際に作成したinline comment数（dry-runは0） |
| `skipped-count` | 理由付きで除外した数（reject・range skip・gate skip・duplicate） |
| `result-path` | runner内の`review-result.json`のパス。run error早期は空 |

#### result-pathのJSON

`status`は`staged`（投稿前の計画） / `dry_run` / `success` / `publisher_error`。主なキー：

- `counts`：accepted / publishable / published / skipped / deduped
- `findings[]`：`stage`と`reason.code`（`anchor_not_found`、`below_supported`、`range_quality_wrong_location`等）、`range`、`validation`（supported / commentWorthy / rangeQuality）、`jevCalls`、`retryUsed`、`publish`
- `publishables[]`：投稿payload、`stage`（planned / posted / unposted）、`commentId`、`ambiguous`
- `publish.failure`：投稿途中失敗のstep・message・ambiguous
- `rejected[]`：Tool入力のper-record reject理由

#### run errorと「指摘0件」の区別

- OpenCode異常終了、Jev障害、壊れた結果ファイル、権限不足、HEAD変更はrun error。exit 1で、stderrに`{"class":"run_error","stage":"...","fields":[...]}`形式のJSONが1行で出る（秘密値は含まない）。GitHubのrun画面では該当stepが赤くなる。
- Tool入力不正やgate不合格はfinding単位のskipで、run自体は継続する。
- OpenCodeが正常終了し`review-result.json`を正常に読めた0件は**成功**（exit 0）。run errorと混同しない。
- GitHub上の確認：Actionsのrun → job → stepのログで上記JSONを探す。`gh run view <run-id> --log`や`gh run view <run-id> --json jobs`でも確認できる。result fileはartifactとして自動公開しないため、必要ならworkflowにupload stepを追加する。

### バージョン固定（2026-10-03時点）

| 対象 | 固定値・方針 |
| --- | --- |
| OpenCode runtime | `@opencode/cli@2.0.22`（v2系）。`npm install -g`で導入（公式docs）。pnpmはpostinstall相当に`--allow-build`の承認が必要 |
| OpenCode実行 | `opencode run --standalone --format json --agent reviewer --model <provider/model> <prompt>`。1 invocation = 1新規session |
| OpenCode model | `model` inputの自由枠。Free方針では`opencode/space-bunny-free`等の無料モデル。提供・制限は期間限定の可能性があり、有料へ自動fallbackしない |
| Jev model | `jev-model` input。既定`jev-1.13-free`（Zen gateway、期間限定の可能性）。`jev-1.13`は有料のopt-in |
| GitHub API | `X-GitHub-Api-Version: 2026-03-10`、redirect手動、3xxエラー |
| Action実行環境 | `runs.using: node24` / `main: dist/index.js`（開発Node 26とは区別） |
| Action参照 | commit SHA固定を推奨。tag運用は公開時に決定（Q09） |

## 開発

開発環境は`vp`でNode **26.8.2**・pnpm **12.6.0**を固定する（`docs/development.md`）。

```sh
vp run typecheck                  # strict TypeScript
vp run test                       # fixtureテスト 263件（Node標準runner）
vp env exec node --test test/jev/ # Jev契約のmock/fixture 14件
vp run build                      # dist/index.js + dist/metafile.json
vp run build:verify               # 2回buildしてsha256一致 + checked-in distとの一致
vp run bundle:check               # docs/bundle-baseline.json に対するraw/gzip差分
bash test/smoke/dist-only-smoke.sh # node:24-alpine + distのみの起動smoke（Docker）
```

`vp run test`は`test/`配下の`*.test.ts`をNodeのtype strippingで実行し、`test/live/*`は実ネットワーク・実CLI・実Dockerが必要なmanual seamとして対象外。必須環境変数は各harness冒頭のコメントを正本とする。`test/live/`の使い分け：

| harness | 前提 | 内容 |
| --- | --- | --- |
| `phase6-anchor-live.mjs` | `OPENCODE_CLI`でpinned `@opencode/cli`指定 + 無料モデルのネットワーク | 実モデルに欠陥2件を検出させ、HEAD完全一致anchorがRange Resolverを通るか確認（投稿なし） |
| `two-skill-check.mjs` | `vp run build`後。ネットワーク不要 | built distを2 Skillで連続実行し、staging cleanup・result/output分離・cross-runなしをassert |
| `live-smoke.ts` | `OPENCODE_CLI` + 無料モデルのネットワーク | Phase 2 producer smoke。`report_finding`のNDJSONを表示（投稿なし） |
| `phase5-live.mjs` | scratch PR、`LIVE_*` env、`gh auth token`、pinned CLI | 本番publisherの実inline投稿/dry-run確認（`LIVE_DRY_RUN=false`は投稿する） |
| `phase5-probes.mjs` | scratch PR、`LIVE_*` env | 422 / stale `commit_id`を直接APIで観察するprobe（commentをPOSTする） |
| `jev-calibration.mjs` | ネットワーク | Zenの匿名`jev-1.13-free`で判定傾向を確認 |

`dist/`はAction配布物として追跡する。開発sessionはmainリポジトリへcommitしない方針のため、checked-in distとの一致は`vp run build:verify`のsha256比較で確認し、ユーザーの初回push以降はCIの`git diff --exit-code -- dist/`でも検証される。CI（`.github/workflows/ci.yml`）はtypecheck・全テスト・build・再現性・bundleサイズ・two-skill分離・actionlint（v1.7.12固定）・dist-only smokeを実行する。

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [ツール概要](docs/overview.md) | 目的、MVP、利用イメージ、Action入出力 |
| [アーキテクチャ](docs/architecture.md) | 構成図・シーケンス図、型、NDJSON、範囲解決、検証・投稿 |
| [実装計画](docs/implementation-plan.md) | フェーズ、依存関係、テスト、完了条件 |
| [開発環境](docs/development.md) | Node 26・pnpm 12の指定、検証コマンド、CI |
| [設計判断・未決事項](docs/decisions.md) | 採用方針、変更点、初期検証が必要な点 |
| [参照資料](docs/references.md) | 元会話と確認した公式仕様 |
| [AGENTS.md](AGENTS.md) | 最小限の英語のコーディング規約 |
