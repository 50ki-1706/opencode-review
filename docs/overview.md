# ツール概要

## 目的

リポジトリのレビュー方針をSkillとして管理し、GitHub Actions上のOpenCodeにその方針でPRを調査させる。AIが発見した問題を、プログラムで定義した型・実コード・PR diff・Jevの判断で検証し、根拠と位置が確認できた指摘だけをinline review commentとして投稿する。

人が読む指摘文はOpenCodeが作成する。構造、ID、Skill名、確定した行範囲、投稿可否はCoreが管理する。AIの構造化データ出力を自由文から復元する処理は設けない。

## MVPスコープ

| 項目 | 方針 |
| --- | --- |
| 実行環境 | GitHub Actions、初期はLinux runner |
| イベント | `pull_request`のopened / synchronize / reopened / ready_for_review |
| レビュー実行 | OpenCode公式runtime（`@opencode/cli@2.0.22`固定、`opencode run --standalone`）。公式GitHub Actionの再利用はPhase 0で不採用（自動投稿するため） |
| Skill | `.opencode/skills/<name>/SKILL.md`。1 invocationで1つ |
| 結果受付 | `report_finding` custom toolのみ |
| 指摘の重要度 | `critical` / `high` / `medium` / `low` |
| 範囲 | 固定したPR HEADの新側（`RIGHT`）のコメント可能範囲 |
| 検証 | 型・入力整合性 → Range Resolver → Jev → Publish Gate |
| 投稿 | 1 PublishableFinding = 1 inline review comment |
| dry-run | 投稿以外は通常実行と同じ。投稿payloadと判定理由を出力 |
| 実装 | TypeScript + Valibot、開発Node 26 / pnpm 12（vp管理）、配布ActionはNode 24、esbuildで単一bundle |

削除行への`LEFT`コメント、GitLab、Pi等の別Harness、総合summary投稿、APPROVE / REQUEST_CHANGES、過去レビューの更新・削除・永続的な重複排除、Go併用はMVPの対象外とする。現在の1 invocation内の完全一致重複は除去する。

「OpenCode Free」はモデル選択の方針であり、特定モデルをコードへ固定する要件ではない。無料モデルの提供・認証・制限は変わり得るため、利用可能なモデルを確認して`model` inputへ渡す。無料モデルが利用できない場合、有料モデルへ自動切替しない。[OpenCode Zen](https://opencode.ai/docs/zen/)

## 利用イメージ

以下は**実装後の利用例**。`OWNER/opencode-review@v1`と`PROVIDER/MODEL`は置き換えが必要で、まだ実在する配布Actionを示していない。runtime導入はPhase 0で確定した`@opencode/cli@2.0.22`を使う。`model`は`provider/model`の自由枠で、Free方針では`opencode/...`の無料モデルを選ぶ。

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
        uses: OWNER/opencode-review@v1
        with:
          skill: security-review
          model: PROVIDER/MODEL
          dry-run: 'false'
          github-token: ${{ github.token }}
        env:
          JEV_API_KEY: ${{ secrets.JEV_API_KEY }}
          # OpenCodeのprovider認証は通常不要（Free方針）。有料providerを使う場合だけ専用secretを追加する。
          # GITHUB_TOKEN等の他secretは子プロセスへ渡さない。

      - name: Bug review
        uses: OWNER/opencode-review@v1
        with:
          skill: bug-review
          model: PROVIDER/MODEL
          dry-run: 'false'
          github-token: ${{ github.token }}
        env:
          JEV_API_KEY: ${{ secrets.JEV_API_KEY }}
```

checkout対象はデフォルトのmerge refではなく、イベントのPR HEAD SHAに合わせる。最新PR情報と一致しなければ投稿しない。PR diffはmerge-baseとこのHEADの比較から構成する。

GitHubのfork PRでは標準tokenの書き込み権限とsecretsが制限される。MVPの投稿例は同一リポジトリPRを対象とする。fork対応を目的に`pull_request_target`へ変更してPRのコード・設定を実行する構成は採らない。[GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## Actionインターフェース案

Phase 0後に`action.yml`へ落とし込む。追加した値や初期値は実装前の設計案。しきい値はPhase 4と認証付きJev較正で確定する暫定値。

| Input | 必須 / 初期値 | 内容 |
| --- | --- | --- |
| `skill` | 必須 | 1つのSkill名。パスではない |
| `model` | 必須 | OpenCodeの`provider/model` |
| `dry-run` | `false` | `true`ならGitHub投稿を無効化 |
| `github-token` | 投稿時必須 | GitHub metadata読み取り・inline投稿用。子プロセスへ渡さない |
| `jev-model` | `jev-1.13-free`（暫定） | Jev検証に使うモデル。OpenCode用modelとは別 |
| `supported-threshold` | `0.7`（暫定） | 根拠が指摘を支持する判断のしきい値、0–1 |
| `comment-worthy-threshold` | `0.6`（暫定） | コメントする価値がある判断のしきい値、0–1 |
| `timeout-seconds` | 初期案600 | OpenCode実行時間の上限 |
| `max-findings` | 初期案100 | 1 invocationの受付上限。上限超過を記録 |

Jev資格情報は`JEV_API_KEY`でCoreに渡す。欠如時はrun errorとし、匿名free経路の成功に依存しない。OpenCodeへ渡すprovider環境変数は明示的な許可一覧を用意する。inputやtoken全体をログへ出力しない。

Output案は`accepted-count`、`publishable-count`、`published-count`、`skipped-count`、`result-path`。dry-runでは`published-count = 0`。`result-path`はrunner内の結果ファイルで、自動的に外部公開するものではない。

## 利用者が確認できる結果

正常実行では各findingの受理・範囲確定・Jev判定・投稿結果を記録する。検証で落ちた指摘には理由を残す。指摘0件は、OpenCodeが正常終了し、結果ファイルを正常に読めた場合に限って正常結果と扱う。

OpenCodeの異常終了、Jev通信障害、不正な結果ファイル、権限不足、実行中のHEAD変更は、指摘なしと区別する。findingの重要度自体でActionを失敗にする運用はMVPに含めない。

契約と失敗時の詳細は[アーキテクチャ](architecture.md)、実装順は[実装計画](implementation-plan.md)を参照。
