# アーキテクチャ

> `opencode-review` の契約を、実行フロー・モジュール構成・型・`report_finding` / NDJSON・Range Resolver・Jev publish gate・publisher / dry-run・トラブルシューティング・既知の制限の順に記述する。実装は完了しており、v0.1.0 として配布済み（2026-10-13）。

## 全体構成

Action が PR context を確定し、OpenCode を Finding Producer として実行する。Core は Tool で渡された候補を検証し、投稿に必要な最終型を生成する。

```mermaid
flowchart TD
    PR[GitHub PR / pull_request] --> MAIN[Action entrypoint / main.ts]
    GH[GitHub metadata + fixed HEAD + PR diff] --> MAIN
    SK[Selected SKILL.md] --> OC
    MAIN --> OC
    subgraph PRODUCER[OpenCode runtime - separate process]
        OC[Skill loading + repository exploration]
        OC --> TOOL[report_finding custom tool]
        TOOL --> LOCAL[Tool schema + lightweight checks]
    end
    LOCAL --> IPC[Invocation-specific NDJSON]
    IPC --> CORE
    subgraph REVIEW[Review Core - TypeScript + Valibot]
        CORE[Canonical schema validation + Finding]
        CORE --> RANGE[Range Resolver]
        RANGE --> JEV[Jev Validator]
        JEV --> GATE[Publish Gate]
        JEV -->|range retry at most once| RANGE
    end
    GATE -->|dry-run| OUT[Payload + decision log]
    GATE -->|publish| PUB[GitHub Publisher]
    PUB --> COMMENT[One inline comment per finding]
    RANGE -->|unresolvable| SKIP[Record skip reason]
    GATE -->|rejected| SKIP
```

OpenCode 依存は Skill discovery / loading、探索 Tool、agent loop、model / provider、custom tool 登録・実行、プロセス起動設定にある。結果を Core へ渡す境界だけを `report_finding` に集約する。Core は OpenCode の session や内部イベント型へ依存しない。

## 正常実行の順序

全 finding を検証して投稿予定を確定した後に投稿を開始する。検証途中の障害では投稿へ進めない。

```mermaid
sequenceDiagram
    participant A as Action / Core
    participant G as GitHub
    participant O as OpenCode
    participant T as report_finding
    participant F as NDJSON file
    participant J as Jev
    A->>G: Read PR base and head SHA
    A->>A: Verify checkout and prepare diff + selected Skill
    A->>F: Create empty invocation file
    A->>O: Start one session with controlled config
    O->>T: Call with predefined finding arguments
    T->>T: Schema + range order + path checks
    alt Invalid tool input
        T-->>O: Rejected with reason
    else Input queued
        T->>F: Append one serialized record
        T-->>O: Queued - not publish approval
    end
    O-->>A: Successful process exit
    A->>F: Read records
    A->>A: Valibot validation + canonical Finding + resolve range
    A->>J: Finding + code evidence + resolved range
    J-->>A: Typed validation result
    A->>A: Evaluate publish gate
    alt Dry run
        A->>A: Write payload and decision log
    else Publish
        A->>G: Recheck current head SHA
        A->>G: POST one review comment per publishable finding
        G-->>A: Created comment ID
    end
```

OpenCode や Jev の実行障害で候補が一部だけ処理された状態では投稿へ進めない。GitHub 投稿自体は複数リクエストなので、途中失敗では既に投稿したコメントが残り得る。

## モジュールと依存

`main.ts` が各処理をつなぎ、`finding.ts` / `range.ts` / `jev.ts` / `github.ts` は `opencode.ts` や `@opencode/*` を import しない。

```text
action.yml                  # node24 / dist/index.js
src/
  main.ts                   # input / event / pipeline / output / cleanup
  finding.ts                # Valibot schemas / canonical types / gate
  opencode.ts               # runtime / selected Skill / Tool / NDJSON
  range.ts                  # fixed HEAD / diff parser / range resolution
  jev.ts                    # HTTP request / response validation / mapping
  github.ts                 # PR metadata / inline payload / publication
  templates.ts              # report_finding plugin text asset accessor
templates/
  report-finding.plugin.ts  # v2 pluginテキストアセット（importなし、esbuildではtextとして同梱）
test/
  fixtures/                 # git diff / findings / Jev / GitHub responses
  jev/                      # Jev契約のmockとfixture
scripts/
  build.mjs                 # esbuild + bundle size report
  check-bundle.mjs          # bundle size gate + 再build determinism
dist/
  index.js                  # Action bundle、追跡対象
```

| 区分 | 使用するもの |
| --- | --- |
| Action実行時 | Valibot、Node built-ins、標準`fetch`、外部`git` / `opencode`プロセス |
| 開発時 | TypeScript、esbuild、型定義、必要な検証ツール |
| OpenCode実行時 | OpenCode公式runtime（`@opencode/cli@2.0.22`）、Tool定義はJSON Schemaのみ（`@opencode/plugin` import不要） |

Toolはv2 pluginのテキスト（素の`export default { id, setup }`、importなし）としてbundleへ含め、実行時に配置する。esbuildではtext loaderとして扱い、文字列中の名前をAction依存として解決しない。Actionの外部実行時依存はValibotのみとし、metafileで不要依存が含まれないことを確認する。[v2 Plugins](https://opencode.ai/v2/docs/build/plugins)、[Valibot Introduction](https://valibot.dev/guides/introduction/)

開発環境は`vp`でNode 26.8.2・pnpm 12.6.0を固定する。配布Actionの`using: node24`とは区別し、build targetと利用APIをNode 24へ合わせる。開発用ツール・機構はActionのbundleに含めない。

## 型と値の所有者

以下のTypeScriptは契約の説明用。実装ではValibot schemaを正式な定義とし、`InferOutput`から型を導出する。

```ts
type Severity = "critical" | "high" | "medium" | "low";

type ReportFindingInput = {
  path: string;
  candidateStart: number;
  candidateEnd: number;
  anchor: string;
  severity: Severity;
  title: string;
  body: string;
};

type Finding = {
  id: string;
  skill: string;
  path: string;
  candidateRange: { start: number; end: number; anchor: string };
  severity: Severity;
  title: string;
  body: string;
};

type ResolvedRange = {
  path: string;
  commitId: string;
  startLine: number;
  endLine: number;
  anchorStartLine: number;
  side: "RIGHT";
  code: string;
};

type RangeQuality = "correct" | "too_narrow" | "too_wide" | "wrong_location";

type ValidationResult = {
  supported: number;       // 0–1
  commentWorthy: number;   // 0–1
  rangeQuality: RangeQuality;
};

type PublishableFinding = {
  id: string;
  skill: string;
  path: string;
  commitId: string;
  startLine: number;
  endLine: number;
  side: "RIGHT";
  severity: Severity;
  title: string;
  body: string;
};
```

`id`はCoreが生成し、`skill`は検証済みAction inputから設定する。repository、PR番号、base/head SHAは`ReviewContext`としてCoreが保持する。AI入力にこれらの上書き用フィールドを設けない。

`candidateStart` / `candidateEnd`は1始まりの整数、両端を含むPR HEADの行番号。`anchor`はHEAD内に実在する、連続したコードの原文。説明やMarkdown fenceは含めない。titleは簡潔な問題名、bodyは発生条件・根拠・影響を記述する。

Severityの目安はcritical＝重大な侵害・広範なデータ損失、high＝主要機能の破綻、medium＝特定条件での実害、low＝局所的な実害。重要度だけで投稿を許可しない。好みのスタイル変更は、Skillの要求と実害の根拠がなければ指摘対象にしない。

## `report_finding`とNDJSON

`report_finding`はv2 plugin形式のテキストアセットをAction管理の一時設定領域の`plugins/`へ生成し、`ctx.tool.transform((editor) => editor.add({ ... }))`で登録する。入力はJSON Schema、`options.codemode: false`でCode Modeの入れ子実行を無効にする。ValibotはCoreが結果を正式に受理するためのschemaであり、この2層の役割を混同しない。素の`export default { id, setup }`はimportなしで動作する（2.0.22ローカル実測）。[v2 Plugins](https://opencode.ai/v2/docs/build/plugins)

Toolの役割は、引数の軽い検証、レコードの直列追記、短い結果応答までとする。Jev・投稿・ID発行・Coreの業務処理は置かない。

| 段階 | 検証内容 | 結果 |
| --- | --- | --- |
| Tool schema | 型、整数・正数、severity、必須文字列の空白のみを拒否 | 不正なら呼び出しを拒否 |
| Tool実装 | start ≤ end、許可された変更path、HEAD内の通常ファイル、サイズ上限 | 理由付きRejected、またはQueued |
| Core / Valibot | 許可された全フィールド、未知フィールド拒否、有限整数、文字列制限、フィールド間整合性、変更path・blobの再確認 | 正式Findingを生成、またはreject理由を記録 |

Toolの返答契約:

```ts
type ToolReceipt =
  | { queued: true }
  | { queued: false; reason: string };
```

Toolはこの値を自分でシリアライズして返す。OpenCodeは即時拒否された入力を修正して再提出できる。**NDJSONではCoreの正式検証はプロセス終了後になるため、Coreのrejectを同じsessionへ即時返すことはできない。** 即時callbackで`accepted` / `findingId`を返す方式は採用しない。

実行ごとに`RUNNER_TEMP`配下へランダムな専用ディレクトリを作り、`findings.ndjson`を空で作成する。1 Tool callにつき1行を`JSON.stringify(input)`で書く。AIへファイルを直接編集させる指示は出さない。ファイル位置はadapterが決める固定値とし、AIの引数にしない。1レコードの例:

```text
{"path":"src/counter.ts","candidateStart":2,"candidateEnd":3,"anchor":"  return n - 1;","severity":"high","title":"increment が 1 小さい値を返す","body":"increment() は n + 1 ではなく n - 1 を返しています。"}
```

並行Tool callはTool内のキューで直列化する。追記完了後に`queued: true`を返す。上限は1レコード32 KiB、ファイル全体4 MiB、件数は`max-findings`。部分行・壊れたJSON・上限超過・ファイル消失は識別して記録し、破損ファイルはrun errorにする。

Actionが空ファイルを事前作成し、OpenCodeが正常終了した場合の0行は正常な「候補なし」。非ゼロ終了・timeoutの後に残ったファイルは成功結果として使わない。プロセス終了・読み取り・検証後、`finally`で一時Toolと作業領域を片付ける。

## OpenCodeの起動とSkill

起動は`opencode run --standalone --format json --agent <review-agent> --model <provider/model> <prompt>`に固定する。

`--standalone`は共有background serviceを使わずprivate serverで実行する。1 invocationで新しいsessionを使い、`--continue` / `--session`による継続はしない。CLIイベントは診断目的に限る。[v2 CLI](https://opencode.ai/v2/docs/cli)

指定Skillを選択して固定HEADのコードを探索し、問題ごとに`report_finding`を呼ぶ。正式結果はTool callのみであること、候補範囲はHEAD行番号であることを共通promptへ含める。v2の権限はagent frontmatterの`permissions`配列（順序付き、last match wins）でgatingし、`skill`は`* deny`→選択Skill allowとする。v1の`permission` mapや`options.permission`には依存しない。[v2 Permissions](https://opencode.ai/v2/docs/permissions)

`skill` inputは名前として検証し、ディレクトリ名とfrontmatterのname一致、必須description、実ファイルの存在を確認する。Skill本文には「Base directory for this skill」が付き、相対参照はそのディレクトリへ解決される。選択Skill配下のファイルを読むには`external_directory`の明示allowが必要で、resourceは`<skill dir>/*`の形にする。`*` denyは管理global configへの暗黙許可も上書きする（2.0.22ローカル実測）。

隔離レシピ（2.0.22ローカル実測、Docker・macOS）: 専用のtemp HOMEを作り、`$HOME/.config/opencode`に管理するconfig・agent・skill・pluginだけを置く。`XDG_CONFIG_HOME=$HOME/.config`、`OPENCODE_DISABLE_PROJECT_CONFIG=1`とし、作業ディレクトリとPWDを一致させた`.git`なしworkspaceで起動する。場所発見はPWD基準。`/etc/opencode`は2.0.22では読まれない。PR側のconfig / custom tool / pluginは実行されず、`.env`も読み込み・継承されないことをdecoyとenv名で確認した。[v2 Config](https://opencode.ai/v2/docs/config)

固定HEADのコード閲覧は一時レビュー作業領域で行い、選択SkillとAction管理Toolだけを配置する。レビューruntimeにはコード閲覧・検索・指定Skill・`report_finding`を許可し、ファイル変更・汎用shell・外部連携Tool・subagentを許可しない構成を採用する。

## Range Resolver

コメントの位置はAIの行番号をそのまま信用せず、同じHEADのblobとPR diffから決定する。

1. イベントとGitHub metadataのHEADを照合し、checkoutを固定する。取得したbase SHAとHEADからmerge-baseを算出する。
2. merge-baseとHEADを比較したdiffを読み、各pathのhunkと新側の行番号を構成する。GitHubの変更ファイル一覧もページ末尾まで取得し、照合する。実行中にHEADが変わった場合は止める。
3. pathはGitのHEAD側pathに完全一致させる。絶対path、`..`、NUL、repo外参照、symlink・submoduleを拒否する。空白や日本語を含むpathは扱い、shellに補間しない。
4. HEADのblobを読み、行番号とanchorを照合する。行末CRLFだけを統一し、空白のtrim・fuzzy matchはしない。
5. 候補範囲内にanchorが完全一致すればその位置を優先する。候補行がずれていた場合は、同じfile内でanchorが一意に完全一致するときだけ位置を補正する。候補外に複数一致した場合は推測しない。
6. anchorを含む最小範囲を基本とし、根拠を示す必要がある連続範囲を確定する。範囲全体が同一hunkの`RIGHT`行としてdiffに存在し、少なくとも1行の追加・変更行を含むことを確認する。
7. `ResolvedRange`にpath・固定HEAD SHA・確定行・原文codeを格納する。Jevへは周辺の証拠も送るが、コメント範囲と証拠範囲を区別する。

renameは新側pathを使う。HEADに存在しない削除file、binary、diff範囲外、別hunkをまたぐ範囲、anchor不在・曖昧、照合不能なdiffはskip理由を残す。hunk headerがないpatchを無理に復元しない。

最小範囲規則: anchor窓（完全一致した連続行）を基準とし、同一hunk内で直接隣接するadded行の最大連続runだけを拡張して含める。runを超えるcontext行は含めず、窓がcontextのみで隣接addedがなければ`no_changed_line_in_range`としてskipする。範囲はanchorの位置合わせにのみAI指定を使う。範囲不合格時の補正は、`too_wide`＝anchor窓への縮小、`too_narrow`＝同一hunk内の隣接added runを現在範囲から±3行capで拡張とし、前回と同じ範囲・解決不能・2回目は`range_retry_exhausted`とする（[Q07](decisions.md)）。

diffは`git diff --no-ext-diff --no-textconv -M --find-renames <merge-base> <HEAD>`のfull diffを自前parseし、GitHub変更path集合と照合する（GitHubがrename・localがadd+deleteのときだけ旧pathの欠落を許容し、それ以外の不一致はrun error）。blobは`git ls-tree -l`（mode 100644/100755のみ許可）と`git show <HEAD>:<path>`（2 MiB / 50,000行上限、NULはbinary）で読む。GitHub diffとローカルdiffの一致、APIが受け付ける単一行・複数行の範囲は、実 git fixture と実サービスの観測（2026-10-03、line 2とstart_line 12 / line 14）で確認した。

## Jev ValidatorとPublish Gate

publish gate は Jev（TypeSafe AI の System One 系モデル）の判断値をしきい値と比較する。

Jev の model は `jev-1.13-free` / `jev-1.13` で、公式には `state` と型付き `questions` を送る HTTP API があり、Noul は 0–1 の判断値、Choice は固定選択肢と `probabilities` / `confidence` を返す。[TypeSafe API reference](https://docs.typesafe.ai/api)

本リポジトリの `jev.ts` が固定する gateway URL は compile 定数の `https://opencode.ai/zen/v1/systemone`（`src/jev.ts`）で、`Authorization: Bearer <OPENCODE_API_KEY>` を付けて送信する。公式 Console docs は同じ model 群に対して `/inference/v1/systemone` 形式の API を記載しているが、**両者の対応関係（alias）は未検証**である。ここで保証しているのは「このコードがこの URL を固定して呼ぶ」ことだけであり、proxy / baseUrl の入力や環境変数はない。

SDKはbundleへ含めない。modelは許可リスト（`jev-1.13-free` / `jev-1.13`）で検証し、応答`model`はrequestのechoを許可する。`cost`は公式未文書のためstring / numberとして受理する。応答は`redirect: "manual"`で受け、3xxはrun error。401は`text/plain`でもbodyをJSON parseして`AuthError`を確認する。Zenでは422がgatewayの`server_error` envelopeで返り得るため、statusだけで分類せずbodyをparseする（`server_error`＝provider障害、`invalid_request_error`または`param`付き＝request invalid）。レート制限のZen側仕様は未文書（UNKNOWN）。質問はプログラム固定の3問（`supported`と`commentWorthy`のNoul、`rangeQuality`のChoiceで`correct`のcriteriaはnull）で、APIの組み込みレビュー機能ではない。

| Core側の項目 | 質問型 | 判断対象 |
| --- | --- | --- |
| `supported` | Noul | 提示されたHEADのコードと証拠が、この指摘の主張を支持しているか |
| `commentWorthy` | Noul | Skill基準で、この問題が修正価値のある具体的な実害を持つか |
| `rangeQuality` | Choice | correct / too_narrow / too_wide / wrong_locationのどれか |

stateは`Finding + ResolvedRange + 周辺コード + 該当diff + 選択Skillの評価基準`。質問文・選択肢はプログラムが固定する。AIのbodyやコード内の文を制御指示として扱わない。Skill基準はHEADのSKILL.md本文（frontmatter除外、最大8000 code unitsのexcerpt）を使う。Jevはコメント文を書き直さず、新しいpath・行番号を生成しない。state上限は24000 UTF-16 code units（`JSON.stringify(state).length`）。超過時はL0–L4の劣化はしご（L1: 前後context各5行、L2: context各3行・hunk 24、L3: context 0・hunk 12、L4: hunk 0）で縮小し、floor超過は`evidence_overflow`としてskipしJevを呼ばない。

応答をValibotで検証し、対応するquestion ID・type・有限値・0–1範囲・許可enumを確認して`ValidationResult`へ写像する。欠損・未知の判定・通信障害を合格へ変換しない。

```text
publishable =
  deterministicRangeChecksPassed
  AND supported >= supportedThreshold
  AND commentWorthy >= commentWorthyThreshold
  AND rangeQuality == correct
```

しきい値は`supported = 0.7`、`commentWorthy = 0.6`（`>=`）。匿名較正（`jev-1.13-free`、6ケース、2026-10-03）では正例がsupported 0.93–0.95 / commentWorthy 0.90–0.96で合格、誤指摘が0.01–0.08で不合格となり、暫定値を維持した（生値と限界は[既知の制限と較正](#既知の制限と較正)と[Q06](decisions.md)）。確率値を正しさの保証と扱わない。

範囲だけが不合格の場合、再解決＋再評価は最大1回。`too_wide`ならanchorを含む最小範囲への縮小、`too_narrow`なら同じhunk内で原文根拠を含む範囲への拡張を候補にする。`wrong_location`、補正結果が前回と同じ、補正不能は`range_retry_exhausted`または`range_quality_wrong_location`でskipし、同じ入力のJev再評価を繰り返さない。gate skipのreason codeは`below_supported` / `below_comment_worthy` / `range_quality_wrong_location` / `range_retry_exhausted` / `evidence_overflow`。

通信上の再試行と範囲の再評価は別の上限にする。Jevの一時的な429 / 529 / 5xx / network / timeoutは最大3 attempts（初回＋2回）、Retry-After秒を上限30sで遵守（超過は即失敗）、指定がなければ1s基数の指数backoff、1 attemptあたり60sで打ち切る。401 / 403や応答schema不一致は即時run error。Jevを省略したfindingの本番投稿は許可しない。

## GitHub Publisher / dry-run

Publisherは`PublishableFinding`だけを受け付ける。最終payloadを作る同じ関数を通常投稿とdry-runで使う。

```json
{
  "commit_id": "<fixed-pr-head-sha>",
  "path": "src/example.ts",
  "start_line": 10,
  "start_side": "RIGHT",
  "line": 12,
  "side": "RIGHT",
  "body": "[high] 指摘タイトル\n\n発生条件、根拠、影響。"
}
```

`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`を使う。`line`は確定範囲の終端。単一行では`start_line` / `start_side`を省略する。`position`は使わない。[GitHub review comments API](https://docs.github.com/en/rest/pulls/comments)

dry-runはPOSTを呼ばず、投稿予定payloadとskip理由をstdout・結果ファイルに出す。GitHub metadata読み取りやJev呼び出しは必要。stdoutの契約:

```json
{"stage":"dry-run","publishables":[{"findingId":"<uuid>","payload":{"commit_id":"<fixed-pr-head-sha>","path":"src/example.ts","start_line":10,"start_side":"RIGHT","line":12,"side":"RIGHT","body":"[high] 指摘タイトル\n\n発生条件、根拠、影響。"}}],"skipped":[{"id":"<uuid>","stage":"skipped","reason":{"code":"anchor_not_found","message":"anchorと完全一致する行がHEADに存在しません。"}}]}
```

秘密値とOpenCodeの完全な内部traceを結果へ含めない。

投稿直前と後続コメントの前に現在HEADを確認し、固定SHAと一致しなければ残りの投稿を止める。確認直後にHEADが更新される競合は完全には排除できない。2026-10-03の実サービス実測では、旧HEADの`commit_id`を指定したPOSTは201で受理され、応答の`commit_id`は現在HEADへ正規化、`original_commit_id`に指定SHA、行は元位置へアンカーされた。したがってpayloadの`commit_id`は意図したrevisionの記録であり、誤接続の防止は投稿直前のHEAD再確認が担う（[Q10](decisions.md)）。

存在しないpathや範囲外のlineを指定したPOSTは422で拒否される（2026-10-03実測）。

同一run内でpath・範囲・severity・title・bodyが完全一致したfindingは1件にまとめる。別step / 再実行 / 過去レビュー間の重複排除は行わない。

GitHubの403 / 422は権限・範囲・入力の失敗として記録する。POSTの応答が不明なtimeoutなどでは、二重投稿を避けるため盲目的に再送しない。成功したcomment IDと残りの未投稿findingを結果へ残してrunを失敗にする。

## 失敗と診断

正常結果と失敗は結果ファイルと exit code で区別する。

| 状態 | 処理 |
| --- | --- |
| Finding単位の入力・anchor・範囲・Jev gate不合格 | skip/reject理由を保存し、他のfindingを処理 |
| Skill / input / event不正、SHA不一致、diff取得不能 | run error、投稿しない |
| OpenCode異常終了 / timeout、NDJSON破損 | run error、候補を本番投稿に使わない |
| Jev利用不能 / 応答不正 | run error（stage=jev）、検証が完了するまで投稿しない |
| 正常終了・正常結果ファイル・0 finding（全findingのskipを含む） | 成功、投稿0件 |
| GitHub投稿途中の失敗 | run error、成功IDと未投稿候補を記録 |

結果ファイルには固定HEAD、Skill、実行version、件数、findingごとの段階・理由、Jev判定（値・range quality・retry使用）、publishable payload、投稿結果（comment ID / URL、未投稿、失敗、ambiguous、dedup）を保存する。無期限の履歴管理や総合summary投稿は作らない。

## トラブルシューティング

run error は stage 付きで標準エラーへ JSON 出力される。stage ごとの意味と利用者の対応は次のとおり。

| stage | 意味 | 利用者の対応 |
| --- | --- | --- |
| `input` | action.yml input の検証失敗（空白のみ、未知の dry-run 値、範囲外の数値など） | workflow の `with:` を見直す |
| `environment` | 必須環境変数の欠如（`OPENCODE_API_KEY`）など起動前提の失敗 | secret `OPENCODE_API_KEY` を設定する（[API鍵の入手](overview.md#api鍵の入手)） |
| `event` | `GITHUB_EVENT_PATH` の payload が `pull_request` の期待形でない | trigger を `pull_request`（opened / synchronize / reopened / ready_for_review）にする |
| `repository` | 同一リポジトリ PR でない（fork PR は非対応） | 同一リポジトリの non-draft PR で実行する |
| `context` | GitHub metadata と checkout の不一致、実行中の HEAD 移動、Skill 解決失敗、Range Resolver の実行基盤エラー | checkout を `github.event.pull_request.head.sha` に固定して `fetch-depth: 0` を確認し、再実行する。Skill 名と frontmatter の `name` の一致も確認する |
| `config` | 管理 config の生成・子プロセス環境の構成失敗（許可一覧違反、保護 secret との値衝突など） | 子プロセスへ渡す secret の名前と値を確認する（`TYPESAFE_*` / `GITHUB_TOKEN` / `GH_TOKEN` は拒否される） |
| `producer` | OpenCode の起動失敗・非ゼロ終了・timeout・cancellation | `timeout-seconds` と `model` を確認し、workflow で `@opencode/cli@2.0.22` を導入しているか確認する |
| `results` | NDJSON の破損・上限超過・欠落、結果ファイルの書き込み失敗 | 通常は producer 側の異常。再実行し、繰り返す場合は結果ファイルとログを添えて報告する |
| `jev` | 401 / 403（鍵・権限）、応答 schema 不正、Retry-After が 30s を超える rate limit、provider 障害 | `OPENCODE_API_KEY` の有効性とサービス状態を確認する。検証完了まで投稿されない |
| `publisher` | 投稿途中の失敗（HEAD 移動、403 / 422、応答不明の timeout） | 結果ファイルの posted / unposted / ambiguous を確認する。盲目的に再送しない |
| `pipeline` | 想定外の内部失敗 | 結果ファイルとログを添えて報告する |

コメント 0 件はエラー stage ではない。全 finding が skip された run は `status: "success"`・exit 0 で終わり、skip 理由は結果ファイルの `findings[].reason` に残る（[結果の確認](overview.md#結果の確認)）。

## 既知の制限と較正

しきい値と範囲品質の限界は較正の実測に基づく暫定である。

- 較正（匿名`jev-1.13-free`、6ケース、2026-10-03）: 正例は supported 0.93–0.95 / commentWorthy 0.90–0.96 で閾値を大きく上回り、誤指摘は supported 0.01–0.08。6/6 が validated（state level L0）、latency 407–854 ms（median 445 ms）。`supported = 0.7` / `commentWorthy = 0.6`（`>=`）はこの 6 ケースと整合するが、**例数が少ない暫定値**。認証付き較正は未完了。
- 範囲: 範囲が広すぎる finding でも Jev が `correct` と判定して gate を通過した実測がある。`rangeQuality` 単独では範囲の広さを排除できない。また resolver は「anchor 窓＋隣接 added run」を最小範囲として返すため、`too_narrow` / `too_wide` の補正は同じ diff / blob から同じ最小範囲を再構成しやすく、実 resolver 出力では補正が no-op となって `range_retry_exhausted` へ落ちる。再評価 1 回の経路自体は、範囲が最小形より広い / 狭い fabricated range のテストで確認済み。
- 暫定の上限: `timeout-seconds = 600`、`max-findings = 100`、1 レコード 32 KiB、NDJSON 全体 4 MiB、Jev state 24000 UTF-16 code units（L0–L4 の劣化はしご）、Skill excerpt 8000 code units。利用実績や負荷試験に基づく数値ではない。
- テストした model（`opencode/space-bunny-free`）では、anchor の先頭空白が欠落し finding が全件スキップされうる挙動が 4/4 の実測で観察された。他の model で同じことが起こりうる可能性として扱い、free model 一般の性質としては主張しない。

## 参照資料

実装時に確認した外部資料。公式仕様は変更され得るため、使用versionとAPI仕様を再確認する。

| 資料 | 確認した事項 |
| --- | --- |
| [v2 CLI](https://opencode.ai/v2/docs/cli) | `opencode run`、`--standalone`（private server） |
| [v2 Plugins](https://opencode.ai/v2/docs/build/plugins) | pluginの`setup` / `ctx.tool.transform` / `editor.add`、JSON Schema入力、`options.codemode` |
| [v2 Permissions](https://opencode.ai/v2/docs/permissions) | `permissions`配列、last match wins、`external_directory`の`/*`境界 |
| [v2 Skills](https://opencode.ai/v2/docs/skills) | Skill配置・frontmatter、Skill単位の権限 |
| [v2 Config](https://opencode.ai/v2/docs/config) | configの場所とmerge、plugin指定、共有無効化 |
| [Console モデル一覧](https://opencode.ai/v2/docs/console/models/) | 無料modelを含むモデル一覧、APIキーの入手 |
| [TypeSafe API reference](https://docs.typesafe.ai/api) | System Oneの公式HTTP API（state / questions / 応答型）。本リポジトリが固定する gateway URL（`https://opencode.ai/zen/v1/systemone`）との対応関係は未検証 |
| [GitHub review comments API](https://docs.github.com/en/rest/pulls/comments) | inline投稿endpoint、`commit_id`、`line` / `side` / `start_line` / `start_side` |
| [GitHub Action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax) | `runs.using: node24`、inputs / outputs |
| [Valibot Introduction](https://valibot.dev/guides/introduction) | modular API、型推論、実行時validation |
| [Vite+ Environment](https://viteplus.dev/guide/env) | Nodeとpackage managerのproject pin、環境確認 |
