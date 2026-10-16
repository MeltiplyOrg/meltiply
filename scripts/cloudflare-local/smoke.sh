#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp)"
backend_port="${WRANGLER_DEV_PORT:-8787}"
api_base_url="http://127.0.0.1:${backend_port}"
backend_pid=

cleanup_done=0
cleanup() {
  local exit_status=$?
  [[ "$cleanup_done" == "1" ]] && return 0
  cleanup_done=1
  set +e
  if [[ -n "$backend_pid" ]]; then
    # setsid owns the complete Worker process group. Never wait indefinitely:
    # a stuck workerd otherwise prevents runner cancellation and cleanup.
    kill -TERM -- "-$backend_pid" >/dev/null 2>&1 || kill -TERM "$backend_pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 10); do
      kill -0 "$backend_pid" >/dev/null 2>&1 || break
      sleep 0.2
    done
    kill -KILL -- "-$backend_pid" >/dev/null 2>&1 || kill -KILL "$backend_pid" >/dev/null 2>&1 || true
    wait "$backend_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$exit_status" == "0" ]]; then
    rm -f "$log_file"
  else
    printf 'Worker-native smoke log retained at %s\n' "$log_file" >&2
  fi
}
cleanup_on_signal() {
  local code="$1"
  # The outer CI timeout may land while the readiness loop is still polling a
  # wedged port; dump the backend log so the failure is diagnosable.
  cat "$log_file" >&2 2>/dev/null || true
  cleanup
  "$repo_root/scripts/cloudflare-local/teardown.sh" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT
trap 'cleanup_on_signal 130' INT
trap 'cleanup_on_signal 143' TERM
trap 'cleanup_on_signal 129' HUP

WRANGLER_DEV_PORT="$backend_port" \
WRANGLER_DEV_ALLOWED_ORIGINS=http://localhost:3000 \
WRANGLER_DEV_FRONTEND_URL=http://localhost:3000 \
WRANGLER_DEV_PUBLIC_API_URL="$api_base_url" \
  setsid make -C "$repo_root" cloudflare-dev >"$log_file" 2>&1 &
backend_pid=$!
ready=0
printf 'smoke: waiting for backend at %s\n' "$api_base_url" >&2
for _ in $(seq 1 60); do
  if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
    cat "$log_file" >&2
    echo "Worker-native local backend exited before becoming ready" >&2
    exit 1
  fi
  if curl --fail --silent --max-time 2 "$api_base_url/api/v1/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  cat "$log_file" >&2
  echo "Worker-native local backend did not become ready within 60 seconds" >&2
  exit 1
fi
printf 'smoke: backend ready\n' >&2

health="$(curl --fail --silent --max-time 10 "$api_base_url/api/v1/health")"
readiness="$(curl --fail --silent --max-time 10 "$api_base_url/api/v1/ready")"
unauthorized_status="$(
  curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
    "$api_base_url/api/v1/users/me"
)"
cors_status="$(
  curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --request OPTIONS \
    --header 'Origin: http://localhost:3000' \
    "$api_base_url/api/v1/users/me"
)"
webhook_signature_status="$(
  curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'svix-id: msg_local_invalid' \
    --header "svix-timestamp: $(date +%s)" \
    --header 'svix-signature: v1,invalid' \
    --data '{"type":"user.created","data":{"id":"invalid"}}' \
    "$api_base_url/api/v1/auth/webhook"
)"

node -e '
  const health = JSON.parse(process.argv[1]);
  const readiness = JSON.parse(process.argv[2]);
  if (health.status !== "ok") throw new Error("liveness failed");
  if (readiness.status !== "ready") throw new Error("readiness failed");
' "$health" "$readiness"
printf 'smoke: probes passed\n' >&2

[[ "$unauthorized_status" == "401" ]]
[[ "$cors_status" == "204" ]]
[[ "$webhook_signature_status" == "401" ]]
printf 'smoke: contract prerequisites passed\n' >&2

timeout --signal=TERM --kill-after=20s 90s \
  env MELTIPLY_API_BASE_URL="$api_base_url" \
    "$repo_root/packages/contracts/node_modules/.bin/vp" \
    test run test/live-worker.test.ts
printf 'smoke: contract tests passed\n' >&2

timeout --signal=TERM --kill-after=20s 90s \
  env MELTIPLY_API_BASE_URL="$api_base_url" \
    node "$repo_root/scripts/cloudflare-local/measure-public-routes.mjs"

printf 'Worker-native smoke passed: live OpenAPI conformance, CORS, webhook verification, and public-route baseline.\n'
