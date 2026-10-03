#!/usr/bin/env bash
# Phase 6 dist-only smoke (phase-6-05). Shared by CI and local runs.
#
# Builds an image that contains only dist/index.js (plus the one-line ESM module
# declaration) under node:24-alpine and runs it twice:
#
#   1. without JEV_API_KEY  -> structured run_error, stage=environment;
#   2. with a dummy key     -> structured run_error, stage=context (the bundle
#      reached the GitHub metadata read), proving startup beyond input checks.
#
# In both cases the bundle must boot with no node_modules and no dev
# dependencies. The structured JSON line is the Action's documented error
# contract; the script fails if it is missing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="opencode-review-dist-smoke"

docker build -f "$root/test/smoke/dist-only.Dockerfile" -t "$image" "$root"

run_case() {
  local name="$1" expect_stage="$2"
  shift 2
  local output status
  set +e
  output="$(docker run --rm \
    -e INPUT_SKILL=smoke-skill \
    -e INPUT_MODEL=opencode/space-bunny-free \
    -e "INPUT_GITHUB-TOKEN=smoke-token" \
    -e GITHUB_EVENT_PATH=/work/event.json \
    -e RUNNER_TEMP=/tmp \
    -e GITHUB_OUTPUT=/tmp/output.txt \
    -e GITHUB_REPOSITORY=example/repo \
    -v "$root/test/smoke/event.json:/work/event.json:ro" \
    "$@" "$image" 2>&1)"
  status=$?
  set -e
  echo "--- ${name} (exit ${status}) ---"
  echo "$output"
  if [ "$status" -ne 1 ]; then
    echo "${name}: expected exit 1, got ${status}"
    exit 1
  fi
  if ! printf '%s' "$output" | grep -q "\"stage\":\"${expect_stage}\""; then
    echo "${name}: expected a structured run_error with stage=${expect_stage}"
    exit 1
  fi
}

# No JEV_API_KEY: fail-fast during environment validation, before any network call.
run_case "missing JEV_API_KEY" environment

# Dummy JEV_API_KEY: proceed to the GitHub metadata read; a 401/network failure
# is still a clean structured run_error and proves the bundle started normally.
run_case "dummy JEV_API_KEY" context -e JEV_API_KEY=smoke-dummy

echo "dist-only smoke: all cases passed"
