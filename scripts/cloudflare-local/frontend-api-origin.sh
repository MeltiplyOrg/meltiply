#!/usr/bin/env bash
# Fails fast when the frontend Worker's `/api/*` proxy port disagrees with the
# API port the dev stack actually bound.
#
# `frontend/app/wrangler.jsonc` ships `API_ORIGIN` as the local-only fallback
# origin for the proxy, and its comment already states the coupling: the value
# "must match the Wrangler dev API port (WRANGLER_DEV_PORT, default 8787)". When
# WRANGLER_DEV_PORT selects anything else the proxy keeps dialing the default
# port and every API call returns 502 while the API itself is healthy, which
# reads as a broken backend rather than a misconfigured port.
#
# `API_ORIGIN` is a committed `vars` entry, so overriding it per-run would
# require a `.dev.vars` override — and Wrangler folds that file into
# `wrangler types`, which would make the committed `cloudflare-env.d.ts` drift
# and fail `cf-typegen:check`. Checking the coupling at startup keeps the
# generated types stable and still turns the failure into an actionable error
# instead of a silent 502.
#
#   frontend-api-origin.sh <api-port>
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="$repo_root/frontend/app/wrangler.jsonc"
api_port=${1:-${WRANGLER_DEV_PORT:-8787}}

if [[ ! "$api_port" =~ ^[0-9]+$ ]] || ((api_port < 1 || api_port > 65535)); then
  printf 'frontend-api-origin: API port must be 1-65535, got %s\n' "$api_port" >&2
  exit 2
fi

# Read the local API_ORIGIN port from the committed config. The file is JSONC
# and this reads one commented-out-of-scope literal, so a targeted match is
# enough; an unrecognized shape warns instead of blocking the stack.
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
