#!/usr/bin/env bash
# serve (default): serve the HTML report on $REPORT_PORT and keep running.
#                  With RUN_ON_START=true the suite runs once in the background first.
# run:             run the suite once and exit with its exit code (CI, one-off jobs).
set -uo pipefail
cd "$(dirname "$0")/.."

REPORT_DIR="${REPORT_DIR:-playwright-report}"
REPORT_PORT="${REPORT_PORT:-9323}"

case "${1:-serve}" in
  run)
    shift || true
    exec scripts/run-tests.sh "$@"
    ;;
  serve)
    if [ ! -f "$REPORT_DIR/index.html" ]; then
      mkdir -p "$REPORT_DIR"
      cat > "$REPORT_DIR/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Playwright report</title>
<body style="font:16px system-ui;margin:3rem">
<h1>No test run yet</h1>
<p>Tests run on every environment deploy. Refresh this page after the deploy finishes.</p>
HTML
    fi
    if [ "${RUN_ON_START:-false}" = "true" ]; then
      scripts/run-tests.sh &
    fi
    exec npx playwright show-report "$REPORT_DIR" --host 0.0.0.0 --port "$REPORT_PORT"
    ;;
  *)
    echo "Usage: entrypoint.sh [serve|run [playwright args]]" >&2
    exit 64
    ;;
esac
