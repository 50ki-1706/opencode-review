// Direct GitHub API probes for Phase 5 evidence. NOT part of the unit suite and
// NOT run through the Action: it calls POST /pulls/{n}/comments with a payload
// chosen by environment variables so 422 bodies and stale-commit behavior can
// be recorded verbatim (trimmed).
//
// Environment:
//   LIVE_REPO / LIVE_PR / LIVE_GITHUB_TOKEN   target (token passed via env)
//   PROBE_COMMIT   commit_id for the payload
//   PROBE_PATH     default src/counter.ts
//   PROBE_LINE     default 1
//   PROBE_BODY     default "[probe] direct API observation"
const repo = process.env.LIVE_REPO;
const pr = process.env.LIVE_PR;
const token = process.env.LIVE_GITHUB_TOKEN;
if (!repo || !pr || !token) {
  console.error("missing LIVE_REPO / LIVE_PR / LIVE_GITHUB_TOKEN");
  process.exit(2);
}

const payload = {
  commit_id: process.env.PROBE_COMMIT,
  path: process.env.PROBE_PATH ?? "src/counter.ts",
  line: Number.parseInt(process.env.PROBE_LINE ?? "1", 10),
  side: "RIGHT",
  body: process.env.PROBE_BODY ?? "[probe] direct API observation",
};

const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/comments`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2026-03-10",
    "content-type": "application/json",
    "user-agent": "opencode-review-action",
  },
  redirect: "manual",
  body: JSON.stringify(payload),
});

const text = await response.text();
const body = text.length > 3000 ? `${text.slice(0, 3000)}...` : text;
console.log(JSON.stringify({ probe: { path: payload.path, line: payload.line, commit_id: payload.commit_id }, status: response.status, body }, null, 2));
