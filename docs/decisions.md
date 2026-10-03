# 設計判断と未決事項

設計整理日：2026-10-02、v2契約同期：2026-10-03。Phase 6（Action配布準備）まで実装・ローカル検証済みで、hosted E2Eの完全実行だけが`JEV_API_KEY` secret待ち。「採用」はこのプロジェクトの設計方針であり、実装・実測済みを意味しない。確認区分は「公式docs」「fixture」「ローカル実測」「実サービス」を使う。

## 会話から採用した方針

| ID | 状態 | 判断 | 理由 |
| --- | --- | --- | --- |
| D01 | 採用 | GitHub Actions / pull_requestに限定 | 初期スコープを小さくする |
| D02 | 採用 | 1 invocation = 1 Skill = 1 session | Skillごとの評価と設定を明確にする |
| D03 | 採用 | `report_finding`を結果境界にする | 自由文から構造化JSONを復元せず、自前の型へ値を渡す |
| D04 | 採用 | TypeScript + Valibot | 会話中の明示的な選択。Go併用より単純に保つ |
| D05 | 採用 | Actionの実行時依存は原則Valibotのみ | 小さいbundleと低い複雑性を両立する |
| D06 | 採用 | OpenCode Tool境界はv2 pluginのテキストtemplateとJSON Schema | CoreのValibot schemaをOpenCode内部へ依存させない。v1の`tool.schema`（Zod）は旧仕様の語彙であり、v2では`editor.add`へJSON Schemaを渡す（公式docs/ローカル実測） |
| D07 | 採用 | Toolテンプレートを実行時に生成 | plugin / SDK / ZodをAction bundleへ取り込まない。2.0.22実測で素の`export default { id, setup }`はimportなしで動作した |
| D08 | 採用 | invocationごとのNDJSON | 通信serverやIPCライブラリを増やさない |
| D09 | 採用 | Range Resolver → Jev → Publish Gate | 指摘位置と内容を別々に検証してから投稿する |
| D10 | 採用 | 1 finding = 1 inline comment | 指摘単位でGitHubのコードへ関連付ける |
| D11 | 採用 | dry-runは投稿のみ無効 | 通常投稿と同じ検証を確認する |
| D12 | 採用 | 6モジュールを起点とする | 会話後半の小さい構成を優先し、過剰な層分割を避ける |

参照会話の後半を優先し、初期の「CoreもZod」「多層adapter構成」「Go併用候補」は採用しない。Piは元会話の題名・別Harnessの将来候補として扱い、現在の実装対象はOpenCodeにする。

## 文書化時に補った設計

| ID | 状態 | 判断とトレードオフ |
| --- | --- | --- |
| D13 | 採用 | NDJSONでToolの応答はQueued。Core検証の即時callbackとfindingId返却は行わない。再提出できるのはToolが即時拒否した入力 |
| D14 | 採用 | PR HEADを固定し、merge-baseとのdiffを使う。投稿前に最新HEADを再確認する |
| D15 | 採用 | 初期コメントはRIGHT側、同一hunk、変更行を含む範囲。削除側は後続対応 |
| D16 | 採用 | 外部サービスの実行障害では投稿しない。個々の根拠不足とrun errorを区別する |
| D17 | 採用 | 完全一致重複をinvocation内で除去。別stepや過去レビューを読む重複管理は作らない |
| D18 | 採用 | 全findingの検証後に投稿する。投稿途中の失敗は成功IDと未投稿候補を記録する |
| D19 | 確定（2026-10-03） | runtimeは`@opencode/cli@2.0.22`の`opencode run --standalone`に固定。公式GitHub Actionの再利用は不採用（D25） | v2系でversion固定をローカル実測。`--standalone`は共有background serviceを使わない（公式docs）。毎回新規session、`--continue` / `--session`禁止 |
| D20 | 確定（2026-10-03） | JevはTypeSafe AIのSystem Oneと確認。接続はOpenCode Zen gateway `https://opencode.ai/zen/v1/systemone`、初期modelは`jev-1.13-free` | 公式docsと実サービス（匿名200・3判断返却）で確認。認証付き較正は`JEV_API_KEY`依存（D24） |
| D21 | 確定（2026-10-03） | 分離レシピはtemp HOME + `$HOME/.config/opencode`の管理物のみ + `XDG_CONFIG_HOME` + `OPENCODE_DISABLE_PROJECT_CONFIG=1` + cwd=PWD + `.git`なしworkspace | 2.0.22実測。探索はPWD基準、`/etc/opencode`は読まれない（Docker実測）、PR由来config / tool / plugin / `.env`は実効なし |
| D22 | 採用 | 開発環境はNode 26.8.2・pnpm 12.6.0をvpで固定。GitHub配布Actionは対応済みのnode24とし、互換性を検証する |
| D23 | 採用（2026-10-03 廃止:下記D27に置換） | AGENTS.mdは英語の最小限のコーディング規約に限定。実装TODOは文書と分けたplugin用コンテキストを正本とする |
| D24 | 採用（2026-10-03） | Jev認証は`JEV_API_KEY`（TypeSafe）を必須とする。子OpenCode環境への値衝突は無条件run error。匿名free経路に本番依存しない | 匿名`jev-1.13-free`の200はローカル実測できたが、期間限定・保障外。`JEV_API_KEY`欠如時は即run errorとし、無料匿名の成功に依存しない |
| D25 | 採用（2026-10-03） | 対応環境はGitHub-hosted ubuntu runnerと同一リポジトリPRのみ | fork PRは標準token・secretsの制限対象で、`pull_request_target`は採用しない。runner実環境の検証はPhase 6 |
| D26 | 実測・採用（2026-10-03） | Phase 2のproducer境界を確定：GitHub metadataは`X-GitHub-Api-Version: 2026-03-10`・redirect手動・3xxエラー。workspace除外は`.opencode/`・`opencode.json`・`opencode.jsonc`・全`.env*`（`AGENTS.md`は`OPENCODE_DISABLE_PROJECT_CONFIG=1`で探索無効のため保持）。管理configは`opencode.json`とagent frontmatterの両層に同一のv2 permissions配列を置き、plugin canaryのmarker出現を成功条件にする（config silently dropの検出）。`id`はCoreの`crypto.randomUUID()`。Tool側`max-findings`は受付時拒否、Core側は同じ上限をassert（defense-in-depth）。blank-only拒否と長さ上限（path 512 / anchor 5000 / title 200 / body 20000）をToolとCoreの両層で行う。debug時のみ`REVIEW_KEEP_ARTIFACTS=1`でstagingを保持 | 2.0.22実測：agent frontmatter permissionsは動作済み、`opencode.json`のpermissionsは公式v2 docs。canaryがないと管理plugin欠落をexit 0のまま見逃す。`AGENTS.md`はD21の分離で実効がなく、削除対象を実runtime設定に限定する。匿名`opencode/space-bunny-free`のlive smoke（2026-10-03）でcanary出現・exit 0・report_finding 1件・cleanupを実測 |
| D27 | 採用（2026-10-03） | 開発セッションの進捗トラッキング（TODO plugin / context JSON / test:todo）はコードベースから削除。進捗・検証記録の正本は`docs/decisions.md`の日付付き記録とgit履歴 | 配布物・レビューコアと無関係な開発専用機構であり、履歴改変の余地なく検証レベルが文書側に既にある |

公式GitHub Actionを呼ぶことと、公式runtimeを使うことは区別する。Node Action内から別Actionの`uses:`をそのまま実行する構成にはせず、起動方式の判断を`opencode.ts`に閉じ込める。

Phase 2のlive smoke（2026-10-03、`@opencode/cli@2.0.22`、`opencode/space-bunny-free`、匿名）: fixture HEADでcanary markerが出現し、exit 0、`report_finding`経由で`counter.ts` 2行目・severity highのFinding 1件をNDJSONから取得、stagingをcleanupした。modelが返したanchorは先頭空白を除いた`return n - 1;`で、HEAD原文`  return n - 1;`との完全一致判定はPhase 3のRange Resolverが行う（不一致はskip）。workflow checkoutは`ref: ${{ github.event.pull_request.head.sha }}` + `fetch-depth: 0`（merge-base算出にbase側の履歴が必要）をPhase 6のサンプルへ含める。

Phase 3のRange Resolver（2026-10-03、model実行なし）: `git diff --no-ext-diff --no-textconv -M --find-renames <merge-base> <HEAD>`のfull diffを自前parseし、GitHub変更path集合と照合する（Phase 2のrename正規化と整合：GitHubがrename・localがadd+deleteのときだけ旧pathの欠落を許容し、それ以外の不一致はrun error）。`git ls-tree -l`（mode 100644/100755のみ許可）と`git show <HEAD>:<path>`（2 MiB / 50,000行上限、NULはbinary）でHEAD blobを読む。anchorは完全一致のみ（trim・fuzzyなし、行末CRのみ正規化）。collisionは`anchor_ambiguous`でskipし、一意一致の候補外補正だけを許す。実git repo fixture（追加・複数hunk・rename・削除・binary・CRLF・末尾改行なし・空白/日本語path・symlink・submodule・サイズ/行数上限）とdiff parser fixtureで検証し、`node --test`は205 pass（うちrange 61）。補正規則はQ07に固定した。

## Phase 4の同期（2026-10-03）

`src/jev.ts`と検証ステージ（`main.ts`）を実装した。Zen live fact（2026-10-03）との対応：

| 項目 | 実装 |
| --- | --- |
| endpoint / 認証 | `POST https://opencode.ai/zen/v1/systemone`、`Authorization: Bearer`。`JEV_API_KEY`必須で欠如はenvironment run error。匿名`jev-1.13-free`は本番経路にしない（D24再確認） |
| 401 / 403 | bodyをtextとして読みJSON parseし`AuthError`を確認、即時run error・再試行なし・tokenやbodyをメッセージへ出さない |
| 422 | bodyの`error.type`をparse。`server_error`はprovider run error、`invalid_request_error`または`param`付きはrequest invalid（builder bug）としてfail run。statusだけでは分類しない |
| `cost` | 未文書のためstring / numberを受理。gate対象外 |
| model echo | requestのechoを受領し記録。gate対象外 |
| 再試行 | 429 / 529 / 5xx / network / timeoutは最大3 attempts。Retry-After≤30sを厳守（超過は即失敗）、指定なしは1s基数の指数backoff、1 attempt 60s timeout。範囲再評価の1回とは別budget |
| 応答検証 | `jevResponseSchema`のstrict検証。欠損question・未知enum・0–1範囲外・非JSONは`response_invalid` run error（合格へ変換しない） |
| 範囲再評価 | 内容が通過し範囲のみ`too_narrow`/`too_wide`のとき、`reResolveForCorrection`＋Jev再評価を最大1回。同一範囲・`wrong_location`は追加呼び出しなしでskip |

Zen公式docs（2026-10-03）のJev privacy記載: "Jev APIs: Prompts and other inputs are not used for training."。同docsの例はgateway keyとして`OPENCODE_API_KEY`を掲げるが、本プロジェクトはD24どおり`JEV_API_KEY`のみを読む（TypeSafe発行キーでの認証付き経路確認はPhase 6の残存依存）。

### phase-4-07 較正（匿名`jev-1.13-free`、2026-10-03 JST、unit外の`test/live/jev-calibration.mjs`）

Phase 2/3 fixtureのcounter.ts系から手書きした6ケースを、program-fixedの3問とproduction builder（`createJevClient`→実endpoint）で1回実行。raw値：

| ケース | supported | commentWorthy | rangeQuality | 判定 |
| --- | --- | --- | --- | --- |
| correct: increment returns n−1 | 0.95 | 0.96 | correct | 合格 |
| correct: decrement returns n+1 | 0.93 | 0.90 | correct | 合格 |
| false: コードにないclampを主張 | 0.01 | 0.07 | wrong_location | 不合格 |
| false: style preferenceのみ | 0.08 | 0.03 | wrong_location | 不合格 |
| range不良: 主張はincrement、範囲はdecrement | 0.26 | 0.91 | wrong_location | 不合格（supportedとrangeの両方） |
| range不良: 両関数を含む広い範囲 | 0.97 | 0.96 | correct | 合格（too_wideを検出せず） |

観察: 正例はsupported 0.93–0.95 / commentWorthy 0.90–0.96で閾値を大きく上回り、誤指摘はsupported ≤0.08。6/6がvalidated（state level L0）、latency 407–854ms（median 445ms）。`too_wide`の例はJevが`correct`と判定しgateを通過したため、rangeQuality単独では広すぎる範囲を確実に排除できない。閾値0.7/0.6はこの6例と整合するが、範囲検出の限界と例数の少なさから**暫定を維持**する（認証付き較正と例数増加は残存依存）。

実装上の観察（Phase 3との相互作用）: Phase 3のresolverは「anchor窓＋隣接added run」を最小範囲として返すため、`too_narrow`/`too_wide`の補正は同じdiff/blobに対して同じ最小範囲を再構成しやすく、実resolver出力では補正がno-opとなり再評価なしで`range_retry_exhausted`へ落ちる。再評価1回の経路は、範囲が最小形より広い/狭い場合（統合テストのfabricated range）で正しく2回評価されることを確認済み。Phase 5以降で範囲品質を強めるかは較正の蓄積後に判断する。

## Phase 5の同期（2026-10-03）

`src/github.ts`（payload + 単発POST）と`main.ts`（順次投稿のorchestration）を実装した。設計との対応：

| 項目 | 実装 |
| --- | --- |
| payload | `buildInlinePayload(PublishableFinding)`: `commit_id`（固定HEAD、小文字化）・`path`・`body`=`[severity] title\n\nbody`・単一行は`line=endLine`/`side=RIGHT`のみ、複数行は`start_line`/`start_side=RIGHT`を追加。`position`は使わない。dry-runと本番で同一関数 |
| POST | `postInlineComment`: `POST /repos/{o}/{r}/pulls/{n}/comments`、既存`githubFetch`へmethod/bodyを追加。応答はtext→JSON、201 bodyの`id`/`url`をlenient schemaで検証（不一致は記録せずrun error） |
| dry-run | POST 0回。通常と同一payloadとskip理由をstdout JSON（`stage:"dry-run"`）と結果ファイルへ出力し、exit 0（D11） |
| 重複排除 | `dedupePublishables`: `commitId`/`path`/`startLine`/`endLine`/`side`/`severity`/`title`/`body`の完全一致で先頭のみ採用。`dedup.entries`とfinding `reason=duplicate_finding`へ記録し`counts.deduped`へ算入（D17、跨runなし） |
| HEAD再確認 | 各POSTの直前に`verifyHeadCurrent`。不一致・403/422/5xx・network/ambiguous timeout・201 schema不正のいずれでも残りを停止し、成功comment IDと未投稿候補を記録（D18） |
| 曖昧な失敗 | `GitHubError.status===0`（fetch失敗）をambiguous=trueとして記録。盲目的再送はしない |
| 結果ファイル | gate planを`status:"staged"`で先に書き、投稿後に`success`/`dry_run`/`publisher_error`で確定。`publishables[]`にpayload・stage（planned/posted/unposted）・commentId・url・ambiguous、`findings[]`にpublish stage、`dedup`、`publish.failure`、counts（accepted/publishable/published/skipped/deduped）を保存 |
| outputs | `accepted-count`/`publishable-count`/`published-count`/`skipped-count`/`result-path`を全終端経路でbest-effort出力。run error時は0と空result-path（appendOutputsは失敗を握り元結果を隠さない）。exit 0は成功時のみ |

検証: `vp run typecheck` exit 0、`vp run test` 263 pass / 0 fail（Phase 5追加21: payload/post 9、publisher unit+統合12）、`node --test test/jev/` 14 pass、`vp run test:todo` green。bundleはraw 136799 bytes / gzip 32300 bytes（Q08 5点目）。

### phase-5-07 live検証（2026-10-03、scratch repo `50ki-1706/opencode-review-scratch` PR #1）

証拠レベルは**実測 partial**：GitHub metadata/context検証、Range Resolver、Jev（実Zen、匿名）、投稿は本番pipelineの実測。producerのみfake CLI（実OpenCode CLIはモデル実行のみ差し替え）。

- 実モデル試行2回（`opencode/space-bunny-free`、`@opencode/cli@2.0.22`、`test/live/phase5-live.mjs`）はいずれも欠陥1件を検出したが、anchorが先頭空白を欠いたため`anchor_not_found`でskip（Phase 2/3既知の制約。範囲・投稿には到達せず）。
- fake producer CLI（`test/live/phase5-fake-cli.mjs`、実producer経路のspawn/canary/NDJSONをそのまま使用）で2欠陥を再現：
  - dry-run: payload 2件（単一行line 2、複数行start_line 12/line 14）、POST 0回、`status:"dry_run"`、exit 0。
  - 投稿: `published=2`、comment id 4168309537（単一行・line 2）と4168309817（複数行・start_line 12/line 14）、`gh api`照合で件数・id・path・line・start_line・side=RIGHTが一致。
  - Jev匿名（test-only fetchで`Authorization`を削除、endpointは実Zen）: supported 0.98 / commentWorthy 0.97 / correct、0.95 / 0.89 / correct。
- 422実測（direct API）:
  - PRに存在しないpath: `422 {"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","code":"invalid","field":"pull_request_review_thread.path","message":"could not be resolved"}],...}`
  - 範囲外line: 同形で`code:"custom"`,`field:"pull_request_review_thread.line"`
- stale `commit_id`実測（Action-run後に3rd commitをpushし、旧head SHAでPOST）: **201で受理**。応答の`commit_id`は現在head（e8739207…）へ正規化され、`original_commit_id`に要求した旧SHA（cd646294…）、`line`は元位置（2）にアンカーされた。**固定`commit_id`だけでは別revisionへの誤接続を防げない**ため、投稿直前のHEAD再確認を必須の防御とする（payloadのcommit_idは意図したrevisionの記録として維持）。
- HEAD移動stop実測: 旧SHAのeventで本番pipelineを実行→`stage:"context"`のrun error（`PR head changed during context`）、result fileなし、outputsは0と空result-pathでbest-effort出力。
- 保持の判断: 依頼どおりscratch repo（private）・PR #1・コメント3件（Action投稿2 + stale probe 1）を証拠として残す。削除しない。

残るPhase 6入力: Actionとしてのworkflow実行（checkout ref/fetch-depth、CLI導入、`OPENCODE_CLI` envの扱い）、hosted runnerでの`JEV_API_KEY`認証、実モデルのanchor verbatim率の改善余地。

## Phase 6の同期（2026-10-03）

配布物と利用文書を追加した。すべてmainリポジトリへのcommitなしで検証している（初回commitはユーザー側）。

| 項目 | 実装・検証 |
| --- | --- |
| サンプルworkflow | `examples/pr-review.yml`。opened/synchronize/reopened/ready_for_review、`!draft && head.repo.full_name == github.repository`、`contents:read` / `pull-requests:write`、PR番号concurrency、checkoutは`head.sha`+`fetch-depth:0`+`persist-credentials:false`、`npm install -g @opencode/cli@2.0.22`、`uses: OWNER/opencode-review@<40-hex placeholder>`（Q09）、2 Skillを別stepで実行 |
| 二重skill分離 | `test/live/two-skill-check.mjs`がbuilt distの`run()`をSkill A/Bで連続実行（ローカルGitHub mock、fake producer CLI、stub Jev）。result file path/内容とGITHUB_OUTPUTが分離し、staging残骸なし（`stagingLeftovers: []`）、他runのtitle/pathが混入しないことをassert。CIにも同stepを追加 |
| CI | `.github/workflows/ci.yml`（ubuntu-latest）: Vite+導入→`vp install --frozen-lockfile`→typecheck→`vp run test`→`node --test test/jev/`→build→`git diff --exit-code -- dist/`→`build:verify`→two-skill check→`bundle:check`→actionlint v1.7.12（checksum検証）→dist-only smoke。mainリポジトリ未pushのためCI自体はユーザー初回pushまで未実行（ローカルで同等手順を実測） |
| bundle baseline | `docs/bundle-baseline.json`（policy +15%、baseline raw 137271 / gzip 32449、historyはPhase 1–6のQ08値）。`vp run bundle:check`は現行との差分％を表示して超過を失敗させる |
| build再現性 | `vp run build:verify`（`scripts/check-bundle.mjs determinism`）が2回buildし、raw sha256 `1ce9dec541184322eda60f2a01bea7158687de5acf09bdd0119026f25771df2b`とgzip sha256 `dd67a9f4d4feb109af955e414785af6d8f3e931d3dea9c176a374e06a9310867`の一致、およびchecked-in distとfresh buildの一致を確認。commitなし運用のため`git diff`の代わりにsha256を使う |
| dist-only起動 | `test/smoke/dist-only.Dockerfile`（node:24-alpineに`dist/index.js`のみコピー、ESMの`type`宣言1行）と`test/smoke/dist-only-smoke.sh`。ローカル実測2ケース: JEV_API_KEY欠如→exit 1・`stage:"environment"`、dummy key→exit 1・`stage:"context"`（GitHub metadata readまで到達）。node_modules/dev依存なしで起動する |
| actionlint | v1.7.12をDocker（ローカル）とchecksum付きバイナリ（CI）で実行し、ci.ymlとexamples/pr-review.ymlが0 issue |
| Action参照 | 公開先・タグ運用はQ09のまま。READMEとexampleはプレースホルダを維持し、commit SHA固定を推奨 |
| prepareReview seam | `PrepareReviewDeps`へ`baseUrl` / `fetchImpl`を追加し、`defaultPipelineDependencies`のtest seamがmetadata読み取りにも届くよう修正（two-skill checkが実`run()`をオフライン駆動するために必要。本番はundefinedでapi.github.comのまま） |

### anchor prompt改善と実モデル再測（preflight）

`buildReviewerPrompt`のanchor説明を「read tool出力からそのままコピーし、先頭空白・indentを含む全文字を保持、trim/re-indent禁止」と明記し、正例`"  return n - 1;"` / 誤例`"return n - 1;"`を追加した（promptは2行増のみ）。`test/live/phase6-anchor-live.mjs`（pinned CLI、`opencode/space-bunny-free`、Phase 5と同じ欠陥2件のローカルgit fixture、投稿なし）で2回実行：

| 試行 | 検出 | Range Resolver |
| --- | --- | --- |
| 1 | 1件（increment） | 1件skip（anchor `"return n - 1;"`、先頭空白欠落） |
| 2 | 2件（increment + NaN clamp） | 2件ともskip（multi-line側も先頭行の空白のみ欠落、継続行のindentは保持） |

anchor verbatimはこのfreeモデルでは依然として先頭空白が落ち、4/4が`anchor_not_found`だった。prompt改善は仕様として明確に正しいため維持し、hosted実モデルでは指摘0件（全skip）でもrun成功として扱う（`docs/architecture.md`の失敗表どおり）。verbatim率の恒常改善は残存課題。

### hosted E2E（scratch repo `50ki-1706/opencode-review-scratch` PR #2）

deploy: mainへ`action.yml`・`dist/`・`.github/workflows/self-review.yml`（`uses: ./`、`dry-run:'false'`、`JEV_API_KEY: ${{ secrets.JEV_API_KEY }}`）をpushし、`feature/clamp-defect`（`clamp()`の`value >= max`→`max - 1`の2行欠陥）からPR #2を作成（head `172e11d9d92af6c6c9c6d2b79fa722865aa065c3`）。PR #1とそのcomment 3件は保持。

run 37081080875（pull_request、job `review`、conclusion=failure）のstep結果：

| step | 結果 |
| --- | --- |
| Set up job / actions/checkout@v6 | success（hosted checkout`head.sha`+`fetch-depth:0`） |
| Install OpenCode | success（`npm install -g @opencode/cli@2.0.22`、added 5 packages、hosted runner初実測） |
| Review | failure（`{"class":"run_error","stage":"environment","message":"missing required environment variables","fields":["JEV_API_KEY"]}`、exit 1） |
| Post checkout / Complete job | success |

`gh secret list -R 50ki-1706/opencode-review-scratch`は空で、`JEV_API_KEY`が未設定のためReview以降（context確定→producer→Jev→投稿）は未実行。PR #2のコメントは0件、`gh api`で確認。**残る作業**：リポジトリsecret `JEV_API_KEY`を設定し、`gh run rerun 37081080875 -R 50ki-1706/opencode-review-scratch`（またはPR #2へのpushでsynchronize）で完走させる。run結果は成功でも0件（anchor skip）なら正常であり、comment投稿があれば追加のlive証拠になる。

#### hosted E2E完走（attempt 3、2026-10-03）

`gh secret list -R 50ki-1706/opencode-review-scratch`でsecret名`JEV_API_KEY`の存在を確認（2026-10-03T00:49:33Z更新、値は非表示・名前のみ確認）後にrun 37081080875をrerun。**attempt 3 = conclusion success**（job `review` 54s、00:50:43Z→00:51:37Z、head `172e11d9…`不変）:

| step | 結果 |
| --- | --- |
| Set up job / actions/checkout@v6 | success |
| Install OpenCode | success（`added 5 packages in 12s`） |
| Review | success（`JEV_API_KEY: ***`にmask、所要約30秒・ログtimestampからの概算） |
| Post checkout / Complete job | success |

PR #2のcommentはreview/issueとも0件（`gh api`で確認）。0件投稿は「Review success + 指摘全skip」の正常経路で（`docs/architecture.md`失敗表）、freeモデルのanchor先頭空白欠落（本節preflight 4/4 `anchor_not_found`）と整合する。PR #1のcomment 3件（4168309537 / 4168309817 / 4168316603）は保持。

学習した事実（hosted）: job全体54s（install 12s含む）と短く、`opencode/space-bunny-free`はrunner上でもprovider keyなしで完走した。本Actionは成功時にstdoutを出さず、結果ファイル（`review-result.json`）と`GITHUB_OUTPUT`はrunner内に留まりuploadされないため、hosted runからcounts / per-finding reasonをAPIで取得できない（attempt 3のReview logはinputs/envのheaderのみ）。`JEV_API_KEY`が空でないことは`readJevToken`通過で確認できるが、全findingがrange skipならJevへ到達しないため、tokenのAPI有効性（401等）はこのrunでは未検証。hostedでのcounts観測は結果ファイルuploadが将来の改善候補。

## MVP受け入れ（2026-10-03）

Phase 0–6の成果物を監査し、MVP完了条件（TODO `mvp`）を確認した。fresh validation（2026-10-03 JST、`vp`固定toolchain）はすべてexit 0: `vp env current --json`（Node 26.8.2 / pnpm 12.6.0）、`vp run typecheck`、`vp run test`（263 pass / 0 fail）、`vp env exec node --test test/jev/`（14 pass / 0 fail）、`vp run build` / `vp run build:verify`（raw 137271 / gzip 32449、sha256 `1ce9dec5…`一致）、`vp run bundle:check`（baseline比+0.00%）、`vp run test:todo`（7 pass）。追加で`test/live/two-skill-check.mjs`（Skill A/B分離・staging残骸なし）とdist-only smoke（JEV欠如→stage environment、dummy key→stage context）もexit 0。

| MVP | 判定 | 証拠 |
| --- | --- | --- |
| mvp-01 | 合格 | hosted run 37081080875 attempt 3（scratch repo PR #2、head `172e11d9…`）がconclusion success（job 54s、全step success、2026-10-03、証拠レベル=実機(GitHub Actions)）。`JEV_API_KEY` secret設定（名前のみ確認）後のrerun。PR #2のcommentは0件（review/issueとも）だが、freeモデルのanchor先頭空白欠落（Phase 6 preflight 4/4 `anchor_not_found`）による全skipは正常経路で、mvp-01の完了条件（run完走）を満たす。hostedのcounts / skip reasonは結果ファイル未uploadのためAPI取得不可（「hosted E2E完走（attempt 3）」参照） |
| mvp-02 | 合格 | producerの正式出力は`findings.ndjson`のみ（`src/opencode.ts` L1149 `readFindings`）。promptは「text output is not read by the pipeline」と明示（L251）。`JSON.parse`はNDJSON行（L978）・event JSON（`main.ts` L264）・HTTP応答（github/jev）だけで、AI最終テキストのJSON復元はない。`stdoutTail`はエラー診断のexcerptのみ（L1139）。Phase 2 live smokeで`report_finding`経由のFinding 1件を実測 |
| mvp-03 | 合格 | Tool即時reject（`test/template.test.ts`）、Core per-record reject（`test/opencode-ndjson.test.ts`、id/skill注入は未知フィールドでreject）、range skip（`test/main.test.ts` L397 `anchor_not_found`→stage skipped・reason・skipped-count）、gate skip（`test/finding-schema.test.ts` の境界表 `below_supported` / `below_comment_worthy` / `range_quality_wrong_location`、`test/main.test.ts` L892）。結果ファイルに`findings[].reason`・`rejected[]`・`counts.skipped`が残る。実モデル（Phase 5 live 2回）は`anchor_not_found`で投稿0件 |
| mvp-04 | 合格 | `test/publisher.test.ts` L519: 各POST直前にHEAD再確認（GET→POST→GET→POSTの順序）し、単一行line 2・複数行start_line 12/line 14を1件ずつPOST、commentIdを記録。live証拠（2026-10-03再確認）: scratch PR #1のcomment 4168309537（line 2）と4168309817（start_line 12 / line 14）が`gh api`で取得できる。証拠レベル=実測partial（producerのみfake）。hosted分はmvp-01 |
| mvp-05 | 合格 | `test/publisher.test.ts` L395（transportCalls 0）とL431（3 findings全件をJev検証、POST 0、`status:"dry_run"`、payloadが`buildInlinePayload`とdeep-equal、skip理由をstdoutへ）。Phase 5 liveのdry-runも同一payload 2件・POST 0・exit 0 |
| mvp-06 | 合格 | `scripts/build.mjs`がmetafileでtemplate text asset（import 0）、node_modules入力valibotのみ、禁止依存（`@opencode/plugin` / `@opencode-ai` / `zod` / `octokit` / `typesafe`）なし、external importは`node:`のみをassert。`docs/bundle-baseline.json`（+15% policy、Phase 1–6 history）と`vp run bundle:check`でraw/gzipを追跡。fresh実測はbaselineと一致（+0.00%） |
| mvp-07 | 合格 | `docs/architecture.md`「失敗と診断」表。`test/main.test.ts` L493（head_changed/skill→context、config→config、timeout/producer→producer、ndjson_corrupt/limit_exceeded→results）、L530（`JEV_API_KEY`欠如→environment fail-fast）、L544（Jev auth→jev、結果ファイルなし、token非表示）。投稿途中失敗は`test/publisher.test.ts` L629（HEAD移動）/ L677（403）/ L716（422）/ L752（ambiguousは再送せずflag）/ L777（201不正）で成功IDと未投稿を保持。0件は同 L800で`status:"success"`・exit 0。live stale HEADは`stage:"context"`のrun error・結果ファイルなし |
| mvp-08 | 合格 | fresh sessionとしてREADME / `docs/development.md` / `docs/implementation-plan.md`のみで`vp env current --json`→`vp run typecheck`→`vp run test`→`vp run build`を完走。manual seam表に欠けていた`live-smoke.ts`と`phase5-probes.mjs`、`OPENCODE_CLI` / `LIVE_*`前提、`test/live/*`の除外記述をREADME / development.mdへ追記した。fixtureは`test/fixtures`・`test/jev`、失敗解釈はREADME「失敗時の結果確認」で追跡できる |



Phase 0で確認した結果と、残る作業を分けて記録する。

| ID | 確認結果 | 残る作業・依存 |
| --- | --- | --- |
| Q01 | 解決済み。JevはTypeSafe AIと確認。Zen gateway経由、`jev-1.13-free`で匿名200を実サービス確認 | 認証付き較正は`JEV_API_KEY`待ち |
| Q02 | 解決済み。公式GitHub Action（`anomalyco/opencode/github`）は常時PRコメント投稿・更新、branch push・PR作成の可能性がありpure producer不適（ソース実読）。`sst/opencode`はanomalycoへリダイレクト | なし。CLI起動を採用 |
| Q03 | 解決済み。`@opencode/cli@2.0.22`固定、`opencode run --standalone --format json --agent ... --model ...` | runnerへの導入実測はPhase 6 |
| Q04 | 解決済み。分離はD21のレシピ。PR config / tool / plugin / `.env`は実効なし（fixture/ローカル実測） | コピー・削除範囲の実装はPhase 2 |
| Q05 | 暫定。`opencode/space-bunny-free`は匿名で動作（ローカル実測）。提供・認証・制限は保障外で、モデル可用性は期間限定の可能性 | `model` inputで差替え可能にする。Phase 6で再確認 |
| Q06 | 暫定維持（2026-10-03）。supported=0.7 / commentWorthy=0.6（>=）、rangeQuality==correct必須。匿名較正6例では正例0.93–0.95が合格、誤指摘0.01–0.08が不合格。too_wide例は`correct`判定で通過し、範囲品質の限界を記録 | 認証付き較正（JEV_API_KEY）と例数増加。閾値を動かす強い証拠はまだない |
| Q07 | 解決済み（2026-10-03、fixture）。範囲不合格時の再解決＋再評価は最大1回。anchorは候補範囲内の完全一致windowを優先し、候補外はfile内の一意完全一致だけを採用（複数一致は`anchor_ambiguous`でskip）。コメント範囲はanchor窓＋直接隣接する連続added run（同一hunk内・変更行1行以上必須、contextのみは`no_changed_line_in_range`）。`too_wide`はanchor窓（＋隣接added run）へ縮小、`too_narrow`は同一hunk内の隣接added runを現在範囲から±3行capで拡張。補正後の範囲が前回と同じ・解決不能・attempt>=1・`wrong_location`は`range_retry_exhausted`で打ち切る | `test/range.test.ts`（58件）と`test/fixtures/range/*.diff`（実git repo）で検証。補正関数はpure。Phase 4の検証ステージから`reResolveForCorrection`を実diff/blobで呼び、同一範囲なら再評価しないことを統合テストで確認 |
| Q08 | 解決済み（2026-10-03）。Phase 1時点の`dist/index.js`はraw 24999 bytes / gzip 6640 bytes。Phase 2後（`github.ts` / `opencode.ts`追加、runtime依存はvalibotのみ）はraw 79887 bytes / gzip 19219 bytes。Phase 3後（`range.ts`追加）はraw 102066 bytes / gzip 24692 bytes。Phase 4後（`jev.ts`追加）はraw 126974 bytes / gzip 30314 bytes。Phase 5後（payload / publisher / 結果ファイル拡張）はraw 136799 bytes / gzip 32300 bytes。Phase 6後（prompt改善・prepareReview seam・配布物検証）はraw **137271** bytes / gzip **32449** bytes（esbuild 0.28.2、format esm、target node24、valibot 1.5.0、minifyなし、metafileは`dist/metafile.json`） | 完了。`docs/bundle-baseline.json`にpolicy（+15%）・baseline・Phase 1–6 historyを保存し、`vp run bundle:check`をCIへ組み込んだ。意図した増加はQ08へ理由を追記してbaselineを更新する |
| Q09 | 対象外。公開先・version運用・ライセンスは配布作業時 | 配布時。READMEと`examples/pr-review.yml`は`OWNER/opencode-review@<pinned-sha>`のプレースホルダを維持し、公開確定まで実在しない参照を書かない（commit SHA固定を推奨） |
| Q10 | 解決済み（2026-10-03、実サービス）。旧headの`commit_id`を指定したPOSTは201で受理され、応答`commit_id`は現在headへ正規化、`original_commit_id`に指定SHA、行は元位置へアンカーされた。固定`commit_id`は別revisionへの誤接続を防がないため、投稿直前のHEAD再確認を必須の防御とする（Phase 5同期に実測記録） | なし。実装は`publishFindings`の各POST前`verifyHeadCurrent` |

`timeout-seconds = 600`、`max-findings = 100`、レコード32 KiB・全体4 MiB、state上限24000 UTF-16 code unitsは暫定値。利用実績や確認済み制限に基づく数値ではない。

## 残存依存

- 認証付きJev較正（Q06）: TypeSafeの`JEV_API_KEY`取得後に、しきい値と良例多数の判定を較正する。匿名`jev-1.13-free`の6例較正は完了（Phase 4の同期）。Phase 5のlive検証でも匿名経路を実測（実Zen、Authorization除去のtest-only harness）。
- hosted E2E: 完了（2026-10-03）。scratch repo（`50ki-1706/opencode-review-scratch` PR #1）での実inline投稿はPhase 5のlive harnessで完了（実測 partial: producerのみfake CLI）。PR #2のself-review（`uses: ./`、run 37081080875）はattempt 1/2が`JEV_API_KEY`未設定でfailure、secret設定後のattempt 3がhosted完走（success、投稿0件はanchor caveatによる正常扱い）。hosted runのcounts / skip reasonは結果ファイルがuploadされないため取得できない（改善候補）。
- runner実環境検証（Q03/Q05/D25）: Phase 6でGitHub-hosted ubuntu・同一リポジトリPRのworkflowを通し、checkout（`head.sha`+`fetch-depth:0`）と`npm install -g @opencode/cli@2.0.22`の成功を実測。実モデル（`opencode/space-bunny-free`）はPhase 5 live 2回とPhase 6 anchor live 2回のいずれもanchorの先頭空白欠落で`anchor_not_found`となり、verbatim率の改善余地が残る（promptは改善済み、0件runも正常扱い）。

## 判断を更新するとき

検証日、使用version、確認方法、結果、採用した設定を該当IDへ追記する。変更が確定したら概要・型・実装計画も同期させる。「公式docsで確認」「fixtureで確認」「ローカル実測」「実サービスで確認」を区別する。
