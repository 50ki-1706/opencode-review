# ツール概要

> `opencode-review` の目的・できること / 保証しないこと・Action インターフェース・鍵と model の選び方・結果の確認方法をまとめる利用者向けの入口。契約と失敗時の詳細は[アーキテクチャ](architecture.md)、判断の記録は[設計判断](decisions.md)にある。

## 目的

リポジトリのレビュー方針を Skill として管理し、GitHub Actions 上の OpenCode にその方針で PR を調査させる。

人が読む指摘文は OpenCode が作成する。構造、ID、Skill 名、確定した行範囲、投稿可否は Core が管理する。AI の構造化データ出力を自由文から復元する処理は設けない。公式の OpenCode GitHub Action は再利用しない。常時 PR へコメント・更新し、branch push や PR 作成を行いうるため、Core へ結果だけを渡す producer として適さない（[Q02](decisions.md)）。

## できること

実装済みの機能は次のとおり。

| 項目 | 内容 |
| --- | --- |
| 実行 | `pull_request` の opened / synchronize / reopened / ready_for_review で起動。1 invocation = 1 Skill = 1 OpenCode session |
| 結果の受け取り | v2 plugin の `report_finding` Tool を Finding Producer と Review Core の唯一の境界にする。AI の自由文や最終出力は読まない |
| 検証 | Valibot による型・入力整合性 → Range Resolver（固定 HEAD の diff と blob）→ Jev publish gate |
| 投稿 | gate を通過した 1 finding を 1 件の inline review comment として `RIGHT` 側へ投稿。各 POST の直前に現在 HEAD を再確認する |
| dry-run | 投稿以外は通常実行と同じ検証・payload 生成を行い、payload と skip 理由を stdout と結果ファイルへ出力する |
| 依存 | Action 実行時の外部依存は Valibot のみ。配布物は単一 bundle `dist/index.js` |
| 失敗の区別 | run error を stage 付きで報告し、0 件成功・finding 単位の skip と区別する |

## 保証しないこと

次は保証しない。誤解しやすいため明記する。詳細は[既知の制限と較正](architecture.md#既知の制限と較正)を参照。

| 項目 | 内容 |
| --- | --- |
| コメント 0 件 | finding が全件 skip されても run は成功（exit 0）しうる。コメント 0 件は「問題なし」を意味しない |
| 範囲の厳密さ | 範囲が広すぎる finding でも Jev が `correct` と判定すれば gate を通過しうる。rangeQuality 単独では範囲の広さを排除できない |
| しきい値と上限 | `supported-threshold` / `comment-worthy-threshold` と各上限は 6 ケースの較正に基づく暫定値。認証付きの較正は未完了 |
| model の安定性 | テストした無料 model では anchor の先頭空白が欠落し finding が全件スキップされる挙動が実測されている |
| GitHub 操作 | 総合 summary 投稿、APPROVE / REQUEST_CHANGES、過去レビューの更新・削除、別 run をまたぐ重複排除は行わない |
| 実行環境 | fork PR、GitHub-hosted Ubuntu 以外の runner、draft PR は対象外 |

## Actionインターフェース（`action.yml` で定義）

`action.yml` が定義する inputs は 9 個、outputs は 5 個。

| Input | 必須 / 既定 | 内容 |
| --- | --- | --- |
| `skill` | 必須 | 1 つの Skill 名。パスではない。`.opencode/skills/<name>/SKILL.md` として解決する |
| `model` | 必須 | OpenCode の `provider/model`（必要なら `#variant` 付き） |
| `dry-run` | `false` | `"true"` / `"false"` のみ。`true` なら GitHub 投稿を無効化し、payload と判定理由を出力する |
| `github-token` | 実質必須（空文字は拒否） | GitHub metadata 読み取りと inline 投稿用。dry-run でも metadata 読み取りに必要。子プロセスへは渡さない |
| `jev-model` | `jev-1.13-free` | Jev 検証に使う model（`jev-1.13-free` / `jev-1.13`）。OpenCode 用 model とは別 |
| `supported-threshold` | `0.7` | 根拠が指摘を支持する判断のしきい値（0–1、`>=`） |
| `comment-worthy-threshold` | `0.6` | コメントする価値がある判断のしきい値（0–1、`>=`） |
| `timeout-seconds` | `600`（1–3600） | OpenCode 実行時間の上限 |
| `max-findings` | `100`（1–1000） | 1 invocation の受付上限。上限超過は記録する |

| Output | 内容 |
| --- | --- |
| `accepted-count` | Core に受理された finding 数 |
| `publishable-count` | publish gate を通過した finding 数 |
| `published-count` | 投稿した inline comment 数。dry-run では 0 |
| `skipped-count` | 理由付きで skip した finding 数 |
| `result-path` | runner 内の結果ファイル `review-result.json` のパス。自動的に外部公開するものではない |

Jev の credential は `OPENCODE_API_KEY`（OpenCode 発行の単一 credential）で Core に渡す。欠如時は producer を起動する前に environment stage の run error とし、匿名の free 経路に本番依存しない。`model` の provider が `opencode` / `opencode-go` のとき（無料 model 含む）は、同じ credential を子プロセスへ意図的に継承する（[D28](decisions.md)）。子プロセスへ渡す環境変数は明示的な許可一覧で構成し、`TYPESAFE_*` / `GITHUB_TOKEN` / `GH_TOKEN` は渡さない。input や token 全体をログへ出力しない。

## 利用イメージ

同一リポジトリの PR を 2 Skill でレビューする例。**未リリースのため `OWNER` と 40 桁 SHA はプレースホルダ**で、公開後は自分でレビューした commit SHA へ置き換える。

```yaml
name: Skill review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: skill-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Install OpenCode
        run: npm install -g @opencode/cli@2.0.22

      - name: Security review
        uses: OWNER/opencode-review@0000000000000000000000000000000000000000  # 公開後: レビュー済み commit SHA へ置換
        with:
          skill: security-review
          model: opencode/space-bunny-free
          dry-run: 'false'
          github-token: ${{ github.token }}
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
          # OPENCODE_API_KEYはJev gateと`opencode`/`opencode-go` modelのprovider credentialを兼ねる（無料modelでも継承）。
          # 他の有料providerを使う場合だけ専用secretを追加する。GITHUB_TOKEN等の他secretは子プロセスへ渡さない。

      - name: Bug review
        uses: OWNER/opencode-review@0000000000000000000000000000000000000000
        with:
          skill: bug-review
          model: opencode/space-bunny-free
          dry-run: 'false'
          github-token: ${{ github.token }}
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

checkout 対象はデフォルトの merge ref ではなく、イベントの PR HEAD SHA に合わせ、`fetch-depth: 0` で merge-base を算出できる履歴を取る。実行中に HEAD が変われば投稿しない。PR diff は merge-base とこの HEAD の比較から構成する。

## API鍵の入手

OpenCode Console で発行した単一の API キーを Actions secret へ保存する。

[OpenCode Console](https://opencode.ai/console)（サインインは [opencode.ai/auth](https://opencode.ai/auth)）で OpenCode 発行の API キーを取得し、リポジトリの Actions secret に `OPENCODE_API_KEY` として保存する。この 1 つの credential が、Jev publish gate の認証と、provider が `opencode` / `opencode-go` の model（無料 model 含む）の review model 認証を兼ねる。欠如時は producer を起動する前に environment stage で失敗する。有料 provider への自動 fallback はしない。

## model選択

無料 model は提供が変わり得るため、利用可能なものを確認して `model` input へ渡す。

`model` input は OpenCode の `provider/model`（必要なら `#variant` 付き）で指定する。無料 model は `opencode/space-bunny-free` のように `opencode/` 配下にあり、提供・認証・制限は変わり得る（期間限定の可能性がある）。利用可能な model は [Console のモデル一覧](https://opencode.ai/v2/docs/console/models/) または `curl https://opencode.ai/inference/v1/models` で確認する。

`opencode` / `opencode-go` 以外の provider を使う場合は、その provider 自身の API キー（例: `ANTHROPIC_API_KEY`）を step の `env` に設定する。無料 model が使えなくても有料 model へ自動切替しない。Jev の検証 model は `jev-model` input（`jev-1.13-free` / `jev-1.13`）で選ぶ。

## 対応範囲

GitHub-hosted Ubuntu runner 上の、同一リポジトリかつ non-draft の PR を対象とする。

fork PR は標準 token の書き込み権限と secrets が制限されるため対象外で、stage=`repository` の run error（`fork pull requests are not supported`）になる。fork 対応を目的に `pull_request_target` へ変更して PR のコード・設定を実行する構成は採らない（[D25](decisions.md)）。

## 結果の確認

実行結果は runner 内の `review-result.json` に記録され、自動では upload されない。

正常実行では各 finding の受理・範囲確定・Jev 判定・投稿結果を `review-result.json` に記録する。このファイルは `RUNNER_TEMP` 配下に作られ、**自動では upload されない**。workflow で明示的に upload する例:

```yaml
      - name: Upload review result
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: review-result
          path: ${{ runner.temp }}/review-result.json
```

`result-path` output は同じファイルのパスを指す。`counts.deduped`（invocation 内の完全一致重複としてまとめた件数）は結果ファイルだけにあり、output にはない。

正常実行の status は `success` / `dry_run`、投稿途中の失敗は `publisher_error`。結果ファイルは投稿前に gate plan を `staged` で書き、終端で確定する。検証で落ちた指摘には理由を残す。指摘 0 件は、OpenCode が正常終了し、結果ファイルを正常に読めた場合に限って成功として扱う。

OpenCode の異常終了、Jev 通信障害、不正な結果ファイル、権限不足、実行中の HEAD 変更は、指摘なしと区別する。finding の重要度自体で Action を失敗にする運用は行わない。run error の stage ごとの意味と対応は[トラブルシューティング](architecture.md#トラブルシューティング)を参照。
