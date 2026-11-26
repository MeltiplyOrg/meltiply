#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=container-runtime.sh
source "$repo_root/scripts/cloudflare-local/container-runtime.sh"
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"
load_local_env "$repo_root/.env"

require_container_runtime 'the media processor engine smoke'

printf 'processor smoke: running the engine smoke on %s\n' \
  "$(container_image_platform)" >&2

cd "$repo_root"
exec "${BUN:-bun}" run --no-install --filter @meltiply/automation-worker \
  smoke:processor "$@"