#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <url> <output-json>" >&2
  exit 2
fi

url=$1
output=$2
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lighthouse_cli="$repo_root/node_modules/lighthouse/cli/index.js"
chrome_path="$(node -e 'process.stdout.write(require("@playwright/test").chromium.executablePath())')"
profile="$(mktemp -d)"
export HOME="$profile"
chrome_log="$profile/chrome.log"
chrome_pid=

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "$chrome_pid" ]]; then
    kill -TERM -- "-$chrome_pid" 2>/dev/null || kill -TERM "$chrome_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$chrome_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$chrome_pid" 2>/dev/null || kill -KILL "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
  fi
  if [[ "$status" -ne 0 && -s "$chrome_log" ]]; then
    echo "Chromium startup log:" >&2
    cat "$chrome_log" >&2
  fi
  rm -rf "$profile"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

[[ -x "$chrome_path" ]] || { echo "Playwright Chromium is not executable: $chrome_path" >&2; exit 1; }
[[ -f "$lighthouse_cli" ]] || { echo "Lighthouse CLI is missing: $lighthouse_cli" >&2; exit 1; }
mkdir -p "$(dirname "$output")"

setsid "$chrome_path" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port=0 \
  --user-data-dir="$profile" \
  about:blank >"$chrome_log" 2>&1 &
chrome_pid=$!

port=
for _ in $(seq 1 120); do
  if [[ -s "$profile/DevToolsActivePort" ]]; then
    IFS= read -r port <"$profile/DevToolsActivePort"
    [[ "$port" =~ ^[0-9]+$ ]] && break
    port=
  fi
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    wait "$chrome_pid" || true
    echo "Chromium exited before exposing its DevTools port" >&2
    exit 1
  fi
  sleep 0.5
done
[[ -n "$port" ]] || { echo "Chromium did not expose a DevTools port within 60 seconds" >&2; exit 1; }

node "$lighthouse_cli" "$url" \
  --port="$port" \
  --only-categories=performance,accessibility,best-practices,seo \
  --output=json \
  --output-path="$output" \
  --quiet

test -s "$output"

# Apply the app's existing budgets to the retained report: emitting JSON alone
# must not make an inaccessible or slow production build pass the manual CI lane.
"$repo_root/frontend/app/node_modules/.bin/lhci" assert \
  --config "$repo_root/frontend/app/.lighthouserc.json" \
  --lhr "$output"
