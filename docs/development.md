# 開発環境

> 開発ツールチェーンの固定、検証コマンド、CI、manual seam、配布時の注意点をまとめる。コマンドはすべてリポジトリルートで実行する。

## ツールチェーン

Node.js **26.8.2**・pnpm **12.6.0**を`vp env pin`で固定する。

設定は`package.json`の`devEngines.runtime`と`devEngines.packageManager`に保持する。プロジェクトの指定はglobal defaultを変更しない。[Vite+ Environment](https://viteplus.dev/guide/env)

```sh
vp env current --json
vp env exec node --version
vp env exec pnpm --version
```

再指定する場合：

```sh
vp env pin node@26.8.2 pnpm@12.6.0 --no-install
```

`--no-install`は設定の保存のみを行い、未導入のversionは実行時に取得する。

## 検証

変更は次のコマンドで検証する。

```sh
vp run typecheck
vp run test
vp env exec node --test test/jev/
vp run build
vp run build:verify
vp run bundle:check
```

- `vp run test`は`test/`配下の`*.test.ts` / `*.test.js` / `*.test.mjs`をNode標準runnerで実行する。`test/live/*`、`test/helpers/*`、`test/smoke/*`と`test/jev/mock-server.mjs`はmanual seamまたはfixtureとして実行対象外。
- `vp env exec node --test test/jev/`はJev契約のmockとfixtureだけを検証する。
- `vp run build`は`dist/index.js`と`dist/metafile.json`を生成し、実行時依存がValibotのみ・外部importが`node:`のみ・template text assetがimportなしであることをassertする。
- `vp run build:verify`（`scripts/check-bundle.mjs determinism`）は2回buildしてrawとgzipのsha256一致を確認し、checked-in `dist/index.js`が生成元と一致することも確認する。
- `vp run bundle:check`（`scripts/check-bundle.mjs size`）は`docs/bundle-baseline.json`のraw/gzipに対して+15%を超える増加を失敗させる。意図した増加は`docs/decisions.md` Q08に理由を記録し、baselineとhistoryを更新する。
- 依存導入には`vp install`（CIは`--frozen-lockfile`）、scripts実行には`vp run <script>`を使用し、lockfileは`pnpm-lock.yaml`とする。

### distとcommitの扱い

`dist/`はAction配布物として追跡する。

checked-in `dist/index.js`はfresh buildと一致していなければならない。`vp run build:verify`が同じ不変条件をsha256で確認し、CIでは`git diff --exit-code -- dist/`がindexに対して強制する。`dist/`の変更は同じcommitに含める。

## commit / PRタイトル規約

commitメッセージとPRタイトルはConventional Commitsとし、commitlintで検証する。

- ローカル: lefthookの`commit-msg` hookが`commitlint --edit {1}`を実行する。`vp install`のpostinstall（`pnpm-workspace.yaml`の`allowBuilds`）がhookを書き、手動再installは`vp env exec pnpm exec lefthook install`。
- PR: `.github/workflows/pr-lint.yml`の`kevintyj/prlint@v2`がpull_requestでPRタイトルを検証する。checkoutはbase commit（`github.event.pull_request.base.sha`）なので、PR側で`commitlint.config.js`は緩められない。prlintは`@commitlint/config-conventional`をpnpm lock外（npm）で解決する（accepted tradeoff）。
- 緊急skip: `LEFTHOOK=0 git commit ...`または`git commit --no-verify`（非推奨）。

## CI

`.github/workflows/ci.yml`はmainへのpush / pull_request / 手動実行で、次をubuntu-latest上で行う。

1. `curl -fsSL https://vite.plus | bash`でVite+を導入（installerが生成する`~/.config/vite-plus/env`をsourceし、`$XDG_DATA_HOME/vite-plus/bin`（旧レイアウトは`~/.vite-plus/bin`）を`GITHUB_PATH`へ登録する）
2. `vp install --frozen-lockfile`
3. `vp run typecheck`、`vp run test`、`vp env exec node --test test/jev/`
4. `vp run build`と`git diff --exit-code -- dist/`
5. `vp run build:verify`、`vp run bundle:check`
6. built distによるtwo-skill分離check（`test/live/two-skill-check.mjs`）
7. actionlint **v1.7.12**（固定versionをchecksum検証して実行）
8. `test/smoke/dist-only-smoke.sh`（node:24-alpine + `dist/index.js`のみの起動smoke）

ローカルでは次の同等コマンドで再現する。

```sh
vp install --frozen-lockfile
vp run typecheck && vp run test && vp env exec node --test test/jev/
vp run build
vp run build:verify
vp env exec node test/live/two-skill-check.mjs
vp run bundle:check
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 -color .github/workflows/ci.yml .github/workflows/pr-lint.yml examples/pr-review.yml
bash test/smoke/dist-only-smoke.sh
```

## manual seam（`test/live`）

`test/live/`のharnessは通常テストに含めず、maintainerが明示実行する。

`test/live/`のharnessは、ネットワークや実GitHubに触れる確認をしたいときにmaintainerが明示実行する。pinned CLIは`OPENCODE_CLI`、実GitHubを対象にするharnessは`LIVE_*`（repo / PR / tokenなど）の環境変数で前提を渡す。実行方法と必須環境変数は各ファイル冒頭のコメントを正本とする。`REVIEW_KEEP_ARTIFACTS=1`はproducer stagingを保持するdebug用で、通常は設定しない。

## 配布時の実行環境

開発用Node 26とGitHub JavaScript Actionの`runs.using`は別の指定。

現行のGitHub仕様に`node26`はないため、配布Actionは`node24`とし、bundleはNode 24で実行できるAPIとbuild targetを使う。`test/smoke/dist-only.Dockerfile`は`node:24-alpine`に`dist/index.js`だけをコピーし（ESMのmodule type宣言のみ足す）、`node_modules`なしで起動することを`test/smoke/dist-only-smoke.sh`で確認する。[GitHub Action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)

## 開発資料

概要は`docs/overview.md`、型・処理順は`docs/architecture.md`、採用判断は`docs/decisions.md`、配布 / 利用の説明は`README.md`で管理する。

通常テストはfixtureを使う。`.env`や資格情報は追跡しない。bundleサイズの比較基準は`docs/bundle-baseline.json`（履歴は`docs/decisions.md` Q08）。
