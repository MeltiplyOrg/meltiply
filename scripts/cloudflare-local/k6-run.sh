#!/usr/bin/env bash
# Run the real local API k6 scenario against a live Worker stack.
# Uses the grafana/k6 container (no host binary required).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Shared Compose boundary: picks up the devcontainer overlay and scoped
# COMPOSE_PROJECT_NAME so `up prometheus` joins the same stack as the API.
compose=("$repo_root/scripts/cloudflare-local/compose.sh")

base_url="${BASE_URL:-http://127.0.0.1:8787}"
k6_image="${MELTIPLY_K6_IMAGE:-grafana/k6:2.2.0}"
k6_vus="${MELTIPLY_K6_VUS:-5}"
k6_duration="${MELTIPLY_K6_DURATION:-30s}"
k6_auth_token="${K6_AUTH_TOKEN:-}"
prometheus_rw_url="${K6_PROMETHEUS_RW_SERVER_URL:-http://127.0.0.1:9090/api/v1/write}"
skip_prometheus="${K6_SKIP_PROMETHEUS:-0}"
script_path="$repo_root/scripts/cloudflare-local/k6/api-local.js"

usage() {
  cat <<'EOF'
usage: k6-run.sh [--ci] [--skip-prometheus] [--base-url URL] [--vus N] [--duration DUR]

Runs k6 against the live local Meltiply API (real Workers, no mocks).

  --ci               Short CI profile (3 VUs, 20s). Implies Prometheus write when available.
  --skip-prometheus  Do not remote-write metrics to local Prometheus.
  --base-url URL     API base (default http://127.0.0.1:8787)
  --vus N            Virtual users (default 5)
  --duration DUR     k6 duration (default 30s)

Environment overrides: BASE_URL, MELTIPLY_K6_VUS, MELTIPLY_K6_DURATION, K6_AUTH_TOKEN,
K6_PROMETHEUS_RW_SERVER_URL, MELTIPLY_K6_IMAGE, K6_SKIP_PROMETHEUS=1

Note: do not set k6's reserved K6_VUS/K6_DURATION — they override script scenarios.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ci)
      k6_vus="${MELTIPLY_K6_VUS:-3}"
      k6_duration="${MELTIPLY_K6_DURATION:-20s}"
      shift
      ;;
    --skip-prometheus)
      skip_prometheus=1
      shift
      ;;
    --base-url)
      base_url="$2"
      shift 2
      ;;
    --vus)
      k6_vus="$2"
      shift 2
      ;;
    --duration)
      k6_duration="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$script_path" ]]; then
  echo "k6 script missing: $script_path" >&2
  exit 1
fi

wait_for_api() {
  local i
  for i in $(seq 1 60); do
    if curl --fail --silent --max-time 2 "$base_url/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "API not reachable at $base_url/api/v1/health" >&2
  return 1
}

# Returns when Prometheus is already serving, or starts it through the shared
# Compose boundary (project-scoped, overlay-aware) when the baseline file
# exists. Degrades to skip_prometheus instead of failing the run: k6 without
# remote-write still produces valid local output.
ensure_prometheus() {
  if [[ "$skip_prometheus" == "1" ]]; then
    return 0
  fi
  if curl --fail --silent --max-time 2 http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
    return 0
  fi
  if [[ -f "$repo_root/docker-compose.cloudflare.yml" ]]; then
    "${compose[@]}" up -d prometheus >/dev/null
    local i
    for i in $(seq 1 45); do
      if curl --fail --silent --max-time 2 http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
        return 0
      fi
      sleep 1
    done
  fi
  echo "Prometheus not ready on :9090; continuing without remote-write" >&2
  skip_prometheus=1
}

wait_for_api
ensure_prometheus

docker_args=(
  run
  --rm
  --network
  host
  -e
  "BASE_URL=$base_url"
  -e
  "MELTIPLY_K6_VUS=$k6_vus"
  -e
  "MELTIPLY_K6_DURATION=$k6_duration"
  -v
  "$repo_root/scripts/cloudflare-local/k6:/scripts:ro"
)

if [[ -n "$k6_auth_token" ]]; then
  docker_args+=(-e "K6_AUTH_TOKEN=$k6_auth_token")
fi

k6_args=(run)
if [[ "$skip_prometheus" != "1" ]]; then
  docker_args+=(-e "K6_PROMETHEUS_RW_SERVER_URL=$prometheus_rw_url")
  # Native histogram export segfaults in the ARM64 k6 image during the final
  # flush on the hosted runner. Standard remote-write histograms preserve the
  # load/observability contract without crashing the job.
  docker_args+=(-e "K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=false")
  k6_args+=(-o experimental-prometheus-rw)
fi
k6_args+=(/scripts/api-local.js)

printf 'k6 local API load: base=%s vus=%s duration=%s prometheus=%s\n' \
  "$base_url" "$k6_vus" "$k6_duration" \
  "$([[ "$skip_prometheus" == "1" ]] && echo off || echo on)"

docker "${docker_args[@]}" "$k6_image" "${k6_args[@]}"
