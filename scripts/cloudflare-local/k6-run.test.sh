#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT HUP INT TERM

mkdir -p \
  "$fixture/bin" \
  "$fixture/scripts/cloudflare-local/k6" \
  "$fixture/repo/scripts/cloudflare-local/k6"

COMMAND_LOG="$fixture/commands.log"
export COMMAND_LOG

cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
# Simulate k6 success without running a container.
if [[ "$*" == *" grafana/k6:"* ]] || [[ "$*" == *"/scripts/api-local.js"* ]]; then
  printf '{ "meltiply_k6_summary": { "http_reqs": 1 } }\n'
  exit 0
fi
if [[ "$1" == "compose" ]]; then
  exit 0
fi
exit 0
EOF
chmod +x "$fixture/bin/docker"

cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$COMMAND_LOG"
# API health and prometheus ready succeed.
exit 0
EOF
chmod +x "$fixture/bin/curl"

printf '// k6 fixture\n' >"$fixture/scripts/cloudflare-local/k6/api-local.js"
cp "$repo_root/scripts/cloudflare-local/k6-run.sh" \
  "$fixture/repo/scripts/cloudflare-local/k6-run.sh"
# k6-run reaches Prometheus through the real shared boundary, so the fixture
# checkout needs the helper and a baseline compose file next to it.
cp "$repo_root/scripts/cloudflare-local/compose.sh" \
  "$fixture/repo/scripts/cloudflare-local/compose.sh"
cp "$fixture/scripts/cloudflare-local/k6/api-local.js" \
  "$fixture/repo/scripts/cloudflare-local/k6/api-local.js"
printf 'services: {}\n' >"$fixture/repo/compose.dev.yml"
chmod +x \
  "$fixture/repo/scripts/cloudflare-local/k6-run.sh" \
  "$fixture/repo/scripts/cloudflare-local/compose.sh"

export PATH="$fixture/bin:$PATH"
: >"$COMMAND_LOG"

(
  cd "$fixture/repo"
  ./scripts/cloudflare-local/k6-run.sh --ci --vus 2 --duration 5s
)

grep -Fq 'docker run' "$COMMAND_LOG"
grep -Fq 'experimental-prometheus-rw' "$COMMAND_LOG"
grep -Fq 'grafana/k6:' "$COMMAND_LOG"
grep -Fq 'MELTIPLY_K6_VUS=2' "$COMMAND_LOG"
grep -Fq 'MELTIPLY_K6_DURATION=5s' "$COMMAND_LOG"
grep -Fq '/scripts/api-local.js' "$COMMAND_LOG"
grep -Fq 'K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=false' "$COMMAND_LOG"

: >"$COMMAND_LOG"
(
  cd "$fixture/repo"
  ./scripts/cloudflare-local/k6-run.sh --skip-prometheus --base-url http://127.0.0.1:9999
)
grep -Fq 'docker run' "$COMMAND_LOG"
if grep -Fq 'experimental-prometheus-rw' "$COMMAND_LOG"; then
  echo "expected prometheus output to be skipped" >&2
  exit 1
fi
grep -Fq 'BASE_URL=http://127.0.0.1:9999' "$COMMAND_LOG"

if (
  cd "$fixture/repo"
  ./scripts/cloudflare-local/k6-run.sh --unknown 2>"$fixture/err"
); then
  echo "runner accepted unknown option" >&2
  exit 1
fi
grep -Fq 'unknown option' "$fixture/err"

printf 'k6-run hermetic tests passed\n'
