#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=wrangler-env.sh
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"

launch_local_wrangler_backend "$repo_root" advisory \
  'the local media processor' 'Worker backend' \
  workers/api/wrangler.local.jsonc \
  workers/automation/wrangler.local.jsonc \
  workers/state/wrangler.jsonc
