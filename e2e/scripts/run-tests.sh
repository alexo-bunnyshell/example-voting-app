#!/usr/bin/env bash
# Runs the suite once and exits with Playwright's exit code.
# Also writes status.json and results.json next to the HTML report, so whatever
# serves the report can expose the outcome to scripts and CI.
set -uo pipefail
cd "$(dirname "$0")/.."

REPORT_DIR="${REPORT_DIR:-playwright-report}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"
LOCK_DIR=/tmp/playwright-run.lock

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "A test run is already in progress in this container." >&2
  exit 2
fi
trap 'rmdir "$LOCK_DIR"' EXIT

# WAIT_FOR_URLS: comma-separated URLs that must answer before tests start.
IFS=',' read -r -a wait_urls <<< "${WAIT_FOR_URLS:-${BASE_URL:-}}"
if [ "${#wait_urls[@]}" -gt 0 ] && [ -n "${wait_urls[0]}" ]; then
  node scripts/wait-for.mjs "$WAIT_TIMEOUT" "${wait_urls[@]}" || exit 1
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
npx playwright test "$@"
rc=$?

mkdir -p "$REPORT_DIR"
[ -f test-results/results.json ] && cp test-results/results.json "$REPORT_DIR/results.json"
node - "$rc" "$started_at" "$REPORT_DIR/status.json" <<'JS'
const fs = require('fs');
const [rc, startedAt, out] = process.argv.slice(2);
let stats = {};
try { stats = JSON.parse(fs.readFileSync('test-results/results.json', 'utf8')).stats; } catch {}
fs.writeFileSync(out, JSON.stringify({
  status: rc === '0' ? 'passed' : 'failed',
  exitCode: Number(rc),
  startedAt,
  finishedAt: new Date().toISOString(),
  expected: stats.expected ?? null,
  unexpected: stats.unexpected ?? null,
  flaky: stats.flaky ?? null,
  skipped: stats.skipped ?? null,
}, null, 2) + '\n');
JS

if [ -n "${REPORT_URL:-}" ]; then
  echo "Report: $REPORT_URL"
fi
exit "$rc"
