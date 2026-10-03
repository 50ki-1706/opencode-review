// Fake OpenCode CLI for deterministic spawn tests. It emulates only what the
// producer consumes: NDJSON appends, canary marker, exit codes and signal
// behaviour. Behaviour is selected with --fake-*=argv flags because the real
// child environment is an exact allowlist (no test variables can be injected).
// Excluded from test discovery because it is not named *.test.*.
import { appendFile, writeFile } from "node:fs/promises";

const DEFAULT_FINDING = {
  path: "counter.ts",
  candidateStart: 2,
  candidateEnd: 2,
  anchor: "  return n - 1;",
  severity: "high",
  title: "Fixture finding",
  body: "The fixture producer reported one finding.",
};

function argValue(name, fallback) {
  const prefix = `--fake-${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

const mode = argValue("mode", "findings");
const exitCode = Number.parseInt(argValue("exit", "0"), 10);

const stderrText = argValue("stderr", "");
if (stderrText) {
  process.stderr.write(stderrText);
}

if (mode === "hang") {
  // Resists SIGTERM so the KILL fallback path is exercised.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const sleepMs = Number.parseInt(argValue("sleep", "0"), 10);
  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  if (mode === "findings") {
    const ndjsonPath = process.env.REVIEW_NDJSON_PATH;
    if (ndjsonPath) {
      const raw = argValue("findings", "");
      const findings = raw ? JSON.parse(raw) : [DEFAULT_FINDING];
      for (const finding of findings) {
        await appendFile(ndjsonPath, `${JSON.stringify(finding)}\n`, "utf8");
      }
    }
  }
  if (argValue("marker", "1") !== "0" && process.env.REVIEW_CANARY_MARKER) {
    await writeFile(process.env.REVIEW_CANARY_MARKER, "loaded", "utf8");
  }
  process.exitCode = Number.isInteger(exitCode) ? exitCode : 0;
}
