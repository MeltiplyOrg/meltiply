#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT HUP INT TERM

# shellcheck source=wrangler-env.sh
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"

cat >"$fixture/.env" <<'EOF'
BETTER_AUTH_SECRET=local-auth-secret
MAIL_FROM_ADDRESS=no-reply@meltiply.local
TOKEN_ENCRYPTION_KEY=local-encryption-key
ALLOWED_ORIGINS=http://localhost:3000
APP_URL=http://localhost:3000
WRANGLER_DEV_PORT=9999
EOF

WRANGLER_DEV_PORT=7777
load_local_env "$fixture/.env"
[[ "$WRANGLER_DEV_PORT" == "7777" ]]
[[ "$BETTER_AUTH_SECRET" == "local-auth-secret" ]]
[[ "$TOKEN_ENCRYPTION_KEY" == "local-encryption-key" ]]

args=()
append_local_wrangler_env_file args "$fixture/.env"
[[ "${args[0]}" == "--env-file" ]]
[[ "${args[1]}" == "$fixture/.env" ]]
[[ ${#args[@]} -eq 2 ]]

# Env-file values — secret or not — never become command-line arguments, which
# prevents Wrangler's startup banner from logging them.
if printf '%s\n' "${args[@]}" | grep -q "local-encryption-key\|local-auth-secret\|no-reply@meltiply.local"; then
  echo "env-file value was forwarded as a Wrangler command-line argument" >&2
  exit 1
fi

append_local_wrangler_overrides args

for value in \
  "ALLOWED_ORIGINS:http://localhost:3000" \
  "APP_URL:http://localhost:3000"; do
  if ! printf '%s\n' "${args[@]}" | grep -Fxq "$value"; then
    printf 'missing default Wrangler override: %s\n' "$value" >&2
    exit 1
  fi
done

WRANGLER_DEV_ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
WRANGLER_DEV_APP_URL="http://127.0.0.1:3000"
args=()
append_local_wrangler_overrides args

for value in \
  "ALLOWED_ORIGINS:${WRANGLER_DEV_ALLOWED_ORIGINS}" \
  "APP_URL:${WRANGLER_DEV_APP_URL}"; do
  if ! printf '%s\n' "${args[@]}" | grep -Fxq "$value"; then
    printf 'missing Wrangler override: %s\n' "$value" >&2
    exit 1
  fi
done

unset WRANGLER_DEV_ALLOWED_ORIGINS \
  WRANGLER_DEV_APP_URL
ALLOWED_ORIGINS="https://dashboard.example.test"
APP_URL="https://dashboard.example.test"
configure_local_wrangler_network "$repo_root" 3000 8787
[[ "$WRANGLER_DEV_ALLOWED_ORIGINS" == "$ALLOWED_ORIGINS" ]]
[[ "$WRANGLER_DEV_APP_URL" == "$APP_URL" ]]

# The container-runtime flag is explicit so local media processing is a chosen
# mode rather than an accident of the pinned Wrangler default, and an invalid
# value must stop the launcher instead of silently booting without the engine.
container_args=()
WRANGLER_DEV_ENABLE_CONTAINERS=true append_local_wrangler_container_flags container_args
printf '%s\n' "${container_args[@]}" | grep -Fxq -- '--enable-containers=true'
container_args=()
WRANGLER_DEV_ENABLE_CONTAINERS=false append_local_wrangler_container_flags container_args
printf '%s\n' "${container_args[@]}" | grep -Fxq -- '--enable-containers=false'
container_args=()
append_local_wrangler_container_flags container_args
test "${#container_args[@]}" -eq 0
container_args=()
if WRANGLER_DEV_ENABLE_CONTAINERS=maybe \
  append_local_wrangler_container_flags container_args 2>/dev/null; then
  echo "invalid WRANGLER_DEV_ENABLE_CONTAINERS was accepted" >&2
  exit 1
fi
unset WRANGLER_DEV_ENABLE_CONTAINERS

node --test "$repo_root/scripts/cloudflare-local/worker-config-session.test.mjs"
# The type generator reuses the session mirror to keep checkout env files out
# of the checked-in declarations; its regression lives beside it.
node --test "$repo_root/scripts/cloudflare-local/worker-types.test.mjs"
printf 'wrangler local environment tests passed\n'
