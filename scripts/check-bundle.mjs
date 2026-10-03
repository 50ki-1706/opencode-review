// dist/index.js verification for phase-6-03/04/06.
//
// Two modes, both runnable locally and in CI without git history:
//
//   node scripts/check-bundle.mjs size
//     Compare the checked-in bundle against docs/bundle-baseline.json. Growth
//     beyond policy.maxGrowthPercent fails the check so a dependency change has
//     to be acknowledged (and the baseline/history updated with a reason).
//
//   node scripts/check-bundle.mjs determinism
//     Rebuild twice with the pinned toolchain and compare sha256. It also fails
//     when the checked-in dist does not match a fresh build, which is the
//     no-commit equivalent of `git diff --exit-code dist/` (the repository has
//     no commits yet; the first commit is user-side).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distPath = join(root, "dist", "index.js");
const baselinePath = join(root, "docs", "bundle-baseline.json");
const mode = process.argv[2] ?? "size";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function measure() {
  const bytes = await readFile(distPath);
  const gzip = gzipSync(bytes);
  return {
    raw: bytes.length,
    gzip: gzip.length,
    sha256: sha256(bytes),
    gzipSha256: sha256(gzip),
  };
}

function runBuild() {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`build failed with status ${result.status ?? "unknown"}`);
    process.exit(1);
  }
}

function fail(message) {
  console.error(`bundle check failed: ${message}`);
  process.exit(1);
}

if (mode === "size") {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const current = await measure();
  const limit = baseline.policy?.maxGrowthPercent;
  if (typeof limit !== "number" || limit <= 0) {
    fail("docs/bundle-baseline.json is missing policy.maxGrowthPercent");
  }
  let over = false;
  for (const key of ["raw", "gzip"]) {
    const base = baseline.baseline?.[key];
    if (typeof base !== "number" || base <= 0) {
      fail(`docs/bundle-baseline.json is missing baseline.${key}`);
    }
    const percent = ((current[key] - base) / base) * 100;
    console.log(`${key}: baseline ${base} -> current ${current[key]} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%, limit +${limit}%)`);
    if (percent > limit) {
      over = true;
    }
  }
  console.log(`sha256 ${current.sha256} (gzip sha256 ${current.gzipSha256})`);
  if (over) {
    fail(
      `bundle grew more than +${limit}% over docs/bundle-baseline.json. If the growth is intentional, record why in docs/decisions.md Q08 and update baseline + history in docs/bundle-baseline.json.`,
    );
  }
  console.log("bundle size within policy");
  process.exit(0);
}

if (mode === "determinism") {
  const checkedIn = await measure();
  runBuild();
  const first = await measure();
  runBuild();
  const second = await measure();
  if (checkedIn.sha256 !== first.sha256) {
    fail(
      `checked-in dist/index.js does not match a fresh build (checked-in ${checkedIn.sha256}, rebuilt ${first.sha256}). Rebuild and include dist/ with the change.`,
    );
  }
  if (first.sha256 !== second.sha256 || first.gzipSha256 !== second.gzipSha256) {
    fail(
      `build is not deterministic (${first.sha256}/${first.gzipSha256} vs ${second.sha256}/${second.gzipSha256})`,
    );
  }
  console.log(`deterministic build: sha256 ${first.sha256}`);
  console.log(`deterministic gzip: sha256 ${first.gzipSha256} (raw ${first.raw} bytes, gzip ${first.gzip} bytes)`);
  console.log("checked-in dist matches a fresh build");
  process.exit(0);
}

fail(`unknown mode "${mode}" (expected "size" or "determinism")`);
