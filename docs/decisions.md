# 設計判断

> 実装の設計判断をID付きで記録する公開文書。コード中のコメントが D##/Q## のIDで参照する。

## 確定した判断

判断・根拠・現状を ID 単位で記録する。ステータスの「採用」は現在の設計方針、「確定（日付）」は実装・実測で確定した項目、「暫定」は証拠が不足している項目を表す。

| ID | 判断 | 根拠 | 現状 |
| --- | --- | --- | --- |
| D01 | GitHub Actions / pull_requestに限定 | スコープを小さく保つ | 採用（実装済み） |
| D02 | 1 invocation = 1 Skill = 1 session | Skillごとの評価と設定を明確にする | 採用（実装済み） |
| D03 | `report_finding`をFindings ProducerとCoreの結果境界にする | 自由文から構造化JSONを復元せず、自前の型へ値を渡す | 採用（実装済み） |
| D04 | TypeScript + Valibot | 明示的な選択。Go併用より単純に保つ | 採用（実装済み） |
| D05 | Actionの実行時依存はValibotのみ | 小さいbundleと低い複雑性を両立する | 採用（実装済み） |
| D06 | OpenCode Tool境界はv2 pluginのテキストtemplateとJSON Schema | CoreのValibot schemaをOpenCode内部へ依存させない。v1の`tool.schema`（Zod）は旧仕様の語彙であり、v2では`editor.add`へJSON Schemaを渡す（公式docs / ローカル実測） | 採用（実装済み） |
| D07 | Toolテンプレートを実行時に生成 | plugin / SDK / ZodをAction bundleへ取り込まない。2.0.22実測で素の`export default { id, setup }`はimportなしで動作した | 採用（実装済み） |
| D08 | invocationごとのNDJSON | 通信serverやIPCライブラリを増やさない | 採用（実装済み） |
| D09 | Range Resolver → Jev → Publish Gate | 指摘位置と内容を別々に検証してから投稿する | 採用（実装済み） |
| D10 | 1 finding = 1 inline comment | 指摘単位でGitHubのコードへ関連付ける | 採用（実装済み） |
| D11 | dry-runは投稿のみ無効 | 通常投稿と同じ検証を確認する | 採用（実装済み） |
| D12 | 小さなモジュール構成を起点とする（main / finding / opencode / range / jev / github、templatesはテキスト資産） | 過剰な層分割を避ける | 採用（実装済み） |
| D13 | NDJSONでToolの応答はQueued。Core検証の即時callbackとfindingId返却は行わない | 再提出できるのはToolが即時拒否した入力だけに限定する | 採用（実装済み） |
| D14 | PR HEADを固定し、merge-baseとのdiffを使う。投稿前に最新HEADを再確認する | 固定`commit_id`だけでは別revisionへの誤接続を防げない実測がある（Q10） | 採用（実装済み） |
| D15 | コメントはRIGHT側、同一hunk、変更行を含む範囲。削除側は後続対応 | 単一行では`start_line` / `start_side`を省略する。payloadは`buildInlinePayload`が組み立てる | 採用（実装済み） |
| D16 | 外部サービスの実行障害では投稿しない。個々の根拠不足とrun errorを区別する | `stage`付きrun errorとfinding単位のskipを分離する（アーキテクチャ「失敗と診断」） | 採用（実装済み） |
| D17 | 完全一致重複をinvocation内で除去。別stepや過去レビューを読む重複管理は作らない | 完全一致（commitId / path / 範囲 / side / severity / title / body）を`dedupePublishables`でまとめ、`counts.deduped`へ記録する | 採用（実装済み） |
| D18 | 全findingの検証後に投稿する。投稿途中の失敗は成功IDと未投稿候補を記録する | 結果ファイルはgate planを`staged`で先に書き、投稿後に`success` / `dry_run` / `publisher_error`で確定する。outputsは全終端経路でbest-effort出力する | 採用（実装済み） |
| D19 | runtimeは`@opencode/cli@2.0.22`の`opencode run --standalone`に固定。公式GitHub Actionの再利用は不採用（Q02） | v2系でversion固定をローカル実測。`--standalone`は共有background serviceを使わない（公式docs）。毎回新規session、`--continue` / `--session`禁止 | 確定（2026-10-03） |
| D20 | JevはTypeSafe AIのSystem One系modelと確認。接続はOpenCode Zen gateway `https://opencode.ai/zen/v1/systemone`（コードが固定するURL）、初期modelは`jev-1.13-free`。再試行は429 / 529 / 5xx / network / timeoutで最大3 attempts、Retry-After ≤30s厳守（超過は即失敗）、指定なしは1s基数の指数backoff、1 attempt 60s、401 / 403は即時run error | 公式docsと実サービス（匿名200・3判断返却）で確認。modelは`jev-1.13-free` / `jev-1.13`の許可リストで検証する。認証付き較正は未完了（D24）。コードが固定するURLと公式Console docsの`/inference/v1/systemone`の対応関係は未検証 | 確定（2026-10-03） |
| D21 | 分離レシピはtemp HOME + `$HOME/.config/opencode`の管理物のみ + `XDG_CONFIG_HOME` + `OPENCODE_DISABLE_PROJECT_CONFIG=1` + cwd=PWD + `.git`なしworkspace | 2.0.22実測。探索はPWD基準、`/etc/opencode`は読まれない（Docker実測）、PR由来config / tool / plugin / `.env`は実効なし | 確定（2026-10-03） |
| D22 | 開発環境はNode 26.8.2・pnpm 12.6.0をvpで固定。GitHub配布Actionは対応済みのnode24とし、互換性を検証する | `vp run build:verify`とnode:24-alpineのdist-only smokeで検証済み | 採用（実装済み） |
| D23 | AGENTS.mdは英語の最小限のコーディング規約に限定する | エージェント向け規約と実装TODOを分離する意図だったが、TODO機構はD27で削除した | 採用（2026-10-03にD27で置換） |
| D24 | Jev認証は`OPENCODE_API_KEY`（OpenCode発行。変数名はD28で改名）を必須とする。子OpenCode環境への値衝突は無条件run error。匿名free経路に本番依存しない | 匿名`jev-1.13-free`の200はローカル実測できたが、期間限定・保障外。`OPENCODE_API_KEY`欠如時はproducer起動前に即run errorとし、無料匿名の成功に依存しない | 採用（2026-10-03） |
| D25 | 対応環境はGitHub-hosted ubuntu runnerと同一リポジトリPRのみ。fork PRは非対応（stage=`repository`のrun error）。`pull_request_target`は採用しない | fork PRは標準token・secretsの制限対象。GitHub-hosted ubuntuでcheckout（`head.sha` + `fetch-depth:0`）と`npm install -g @opencode/cli@2.0.22`、run完走を実測（2026-10-03）。0件投稿はanchor skipの正常経路 | 採用（2026-10-03） |
| D26 | producer境界（2026-10-03確定）：GitHub metadataは`X-GitHub-Api-Version: 2026-03-10`・redirect手動・3xxエラー。workspace除外は`.opencode/`・`opencode.json`・`opencode.jsonc`・全`.env*`（`AGENTS.md`は`OPENCODE_DISABLE_PROJECT_CONFIG=1`で探索無効のため保持）。管理configは`opencode.json`とagent frontmatterの両層に同一のv2 permissions配列を置き、plugin canaryのmarker出現を成功条件にする（config silently dropの検出）。`id`はCoreの`crypto.randomUUID()`。Tool側`max-findings`は受付時拒否、Core側は同じ上限をassert（defense-in-depth）。blank-only拒否と長さ上限（path 512 / anchor 5000 / title 200 / body 20000）をToolとCoreの両層で行う。debug時のみ`REVIEW_KEEP_ARTIFACTS=1`でstagingを保持 | 2.0.22実測：agent frontmatter permissionsは動作済み、`opencode.json`のpermissionsは公式v2 docs。canaryがないと管理plugin欠落をexit 0のまま見逃す。`AGENTS.md`はD21の分離で実効がなく、削除対象を実runtime設定に限定する。匿名`opencode/space-bunny-free`のlive smoke（2026-10-03）でcanary出現・exit 0・report_finding 1件・cleanupを実測 | 実測・採用（2026-10-03） |
| D27 | 開発セッションの進捗トラッキング（TODO plugin / context JSON / test:todo）はコードベースから削除。進捗・検証記録の正本は`docs/decisions.md`の日付付き記録とgit履歴 | 配布物・レビューコアと無関係な開発専用機構であり、検証レベルは文書側に残る | 採用（2026-10-03） |
| D28 | Jevとレビューmodelのcredential名を`OPENCODE_API_KEY`へ統一し（旧名から改名）、単一のOpenCode発行credentialを共有する。D24の変数名指定と「tokenは子プロセスへ渡さない」条項のみを置換し、認証付きJev必須・匿名free経路に本番依存しない方針は維持する。providerが`opencode` / `opencode-go`のとき（無料model含む）は`OPENCODE_API_KEY`を意図的に子へ継承する。保護値・保護名guardは`TYPESAFE_*`・`GITHUB_TOKEN`・`GH_TOKEN`のみ | レビューmodelとJev gateが同一のOpenCode発行credentialで動くため。無料modelでも継承するのはprovider境界の挙動を一貫させるため | 採用（2026-10-08） |
| Q01 | 解決済み。JevはTypeSafe AIと確認。Zen gateway経由、`jev-1.13-free`で匿名200を実サービス確認 | 認証付き較正は`OPENCODE_API_KEY`の準備後に実施（未完了） | 解決済み |
| Q02 | 解決済み。公式GitHub Action（`anomalyco/opencode/github`）は常時PRコメント投稿・更新、branch push・PR作成の可能性がありpure producer不適（ソース実読）。`sst/opencode`はanomalycoへリダイレクト | なし。CLI起動を採用 | 解決済み |
| Q03 | 解決済み。`@opencode/cli@2.0.22`固定、`opencode run --standalone --format json --agent ... --model ...` | runnerへの導入はGitHub-hosted ubuntuで実測済み（2026-10-03） | 解決済み |
| Q04 | 解決済み。分離はD21のレシピ。PR config / tool / plugin / `.env`は実効なし（fixture / ローカル実測） | なし。実装済み | 解決済み |
| Q05 | 暫定。`opencode/space-bunny-free`は匿名で動作（ローカル実測）。提供・認証・制限は保障外で、モデル可用性は期間限定の可能性 | `model` inputで差替え可能。利用可能なmodelは[Consoleのモデル一覧](https://opencode.ai/v2/docs/console/models/)または`curl https://opencode.ai/inference/v1/models`で確認する | 暫定 |
| Q06 | 暫定維持（2026-10-03）。supported=0.7 / commentWorthy=0.6（>=）、rangeQuality==correct必須。匿名較正6例では正例0.93–0.95が合格、誤指摘0.01–0.08が不合格。too_wide例は`correct`判定で通過し、範囲品質の限界を記録 | 認証付き較正と例数増加。閾値を動かす強い証拠はまだない | 暫定維持 |
| Q07 | 解決済み（2026-10-03、fixture）。範囲不合格時の再解決＋再評価は最大1回。anchorは候補範囲内の完全一致windowを優先し、候補外はfile内の一意完全一致だけを採用（複数一致は`anchor_ambiguous`でskip）。コメント範囲はanchor窓＋直接隣接する連続added run（同一hunk内・変更行1行以上必須、contextのみは`no_changed_line_in_range`）。`too_wide`はanchor窓（＋隣接added run）へ縮小、`too_narrow`は同一hunk内の隣接added runを現在範囲から±3行capで拡張。補正後の範囲が前回と同じ・解決不能・attempt>=1・`wrong_location`は`range_retry_exhausted`で打ち切る | `test/range.test.ts`と`test/fixtures/range/*.diff`（実git repo）で検証。補正関数はpure。実diff/blobを渡す統合テストで、同一範囲なら再評価しないことを確認 | 解決済み |
| Q08 | 解決済み（2026-10-03）。初期bundleはraw 24999 bytes / gzip 6640 bytes。`github.ts` / `opencode.ts`追加後はraw 79887 / gzip 19219。`range.ts`追加後はraw 102066 / gzip 24692。`jev.ts`追加後はraw 126974 / gzip 30314。payload / publisher / 結果ファイル拡張後はraw 136799 / gzip 32300。prompt改善・prepareReview seam・配布物検証後はraw **137271** / gzip **32449**（esbuild 0.28.2、format esm、target node24、valibot 1.5.0、minifyなし、metafileは`dist/metafile.json`） | `docs/bundle-baseline.json`にpolicy（+15%）・baseline・上記6時点のhistoryを保存し、`vp run bundle:check`をCIへ組み込んだ。意図した増加はQ08へ理由を追記してbaselineを更新する | 解決済み |
| Q09 | 対象外。公開先・version運用・ライセンスは配布作業時 | 配布時。READMEと`examples/pr-review.yml`は`OWNER/opencode-review@<40-hex placeholder>`を維持し、公開確定まで実在しない参照を書かない（commit SHA固定を推奨） | 対象外 |
| Q10 | 解決済み（2026-10-03、実サービス）。旧headの`commit_id`を指定したPOSTは201で受理され、応答`commit_id`は現在headへ正規化、`original_commit_id`に指定SHA、行は元位置へアンカーされた。存在しないpath・範囲外lineは422 | 固定`commit_id`は別revisionへの誤接続を防がないため、投稿直前のHEAD再確認を必須の防御とする。実装は`publishFindings`の各POST前`verifyHeadCurrent` | 解決済み |

## 既知の制限と暫定事項

証拠が不足している値・限界を記録する。

- 暫定の上限: `timeout-seconds = 600`、`max-findings = 100`、1レコード32 KiB、NDJSON全体4 MiB、Jev state上限24000 UTF-16 code units、Skill excerpt上限8000 code units。利用実績や負荷試験に基づく数値ではない。
- 較正は未完了: 匿名`jev-1.13-free`の6ケース（2026-10-03）では正例 supported 0.93–0.95 / commentWorthy 0.90–0.96、誤指摘 0.01–0.08、latency 407–854 ms（median 445 ms）。しきい値0.7 / 0.6はこの小さなサンプルと整合するが暫定であり、認証付き較正と例数増加が残る（Q06）。
- 範囲品質の限界: 範囲が広すぎるfindingでもJevが`correct`と判定してgateを通過した実測がある。resolverの最小範囲規則により、範囲不合格時の補正はno-opとなり`range_retry_exhausted`へ落ちやすい（Q07）。
- 無料modelの限界: 「テストした model（`opencode/space-bunny-free`）では、anchor の先頭空白が欠落し finding が全件スキップされうる挙動が 4/4 の実測で観察された。他の model で同じことが起こりうる可能性として扱い、free model 一般の性質としては主張しない。」
- fallbackしない理由: 無料modelが使えない場合も有料modelへ自動切替しない。有料providerの利用は、利用者が`model`とcredentialを明示した場合だけに限定し、予期しない課金とcredential境界の混在を避ける（D24 / D28）。

## 判断を更新するとき

検証日、使用version、確認方法、結果、採用した設定を該当IDへ追記する。変更が確定したら概要とアーキテクチャも同期させる。「公式docsで確認」「fixtureで確認」「ローカル実測」「実サービスで確認」を区別する。
