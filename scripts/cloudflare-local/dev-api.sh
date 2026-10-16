#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=wrangler-env.sh
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"

cd "$repo_root"
load_local_env "$repo_root/.env"

"$repo_root/scripts/cloudflare-local/database.sh" start

wrangler_port="${requested_wrangler_port:-${WRANGLER_DEV_PORT:-8787}}"
frontend_port="${MELTIPLY_FRONTEND_PORT:-${FRONTEND_DEV_PORT:-3000}}"
configure_local_wrangler_network "$repo_root" "$frontend_port" "$wrangler_port"
printf 'API Worker using http://%s:%s\n' "${WRANGLER_DEV_IP:-127.0.0.1}" "$wrangler_port"

# API-only session: no container runs, so loopback stays the signed R2 host and
# the browser reaches the same presigned URLs unchanged.
configure_local_r2_endpoint_host false

wrangler_args=(
  dev
  --config workers/api/wrangler.local.jsonc
  --ip "${WRANGLER_DEV_IP:-127.0.0.1}"
  --port "$wrangler_port"
  --persist-to .wrangler/state
)

append_local_wrangler_env_file wrangler_args "$repo_root/.env"
append_local_wrangler_overrides wrangler_args
append_local_wrangler_container_flags wrangler_args
append_local_r2_endpoint_overrides wrangler_args "$wrangler_port"

exec_local_wrangler "$repo_root" "$wrangler_port" wrangler_args
