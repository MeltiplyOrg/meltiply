#!/usr/bin/env bash
# Wrangler folds `.dev.vars` into `wrangler types`, so API_ORIGIN cannot be
# overridden per run without drifting the committed cloudflare-env.d.ts.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="$repo_root/frontend/app/wrangler.jsonc"
api_port=${1:-${WRANGLER_DEV_PORT:-8787}}

if [[ ! "$api_port" =~ ^[0-9]+$ ]] || ((api_port < 1 || api_port > 65535)); then
  printf 'frontend-api-origin: API port must be 1-65535, got %s\n' "$api_port" >&2
  exit 2
fi

configured_port="$(
  sed -n 's/.*"API_ORIGIN"[[:space:]]*:[[:space:]]*"[^"]*:\([0-9][0-9]*\)".*/\1/p' \
    "$config" | head -n 1
)"

if [[ -z "$configured_port" ]]; then
  printf 'frontend-api-origin: could not read API_ORIGIN from %s\n' "$config" >&2
  printf '  the frontend Worker may proxy /api/* to the wrong port\n' >&2
  exit 0
fi

if [[ "$configured_port" != "$api_port" ]]; then
  cat >&2 <<MISMATCH
frontend-api-origin: the frontend Worker proxies /api/* to port ${configured_port}
  but this stack bound the API Worker to port ${api_port}. Every browser API
  call would fail with 502 while the API itself is healthy.
Fix by keeping WRANGLER_DEV_PORT=${configured_port}, or by updating API_ORIGIN
  in frontend/app/wrangler.jsonc and running \`bun run --filter frontend-app cf-typegen\`.
MISMATCH
  exit 1
fi
