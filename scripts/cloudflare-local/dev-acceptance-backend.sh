#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=wrangler-env.sh
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"

launch_local_wrangler_backend "$repo_root" required \
  'the acceptance media processor' 'Acceptance Worker backend' \
  workers/api/test-support/wrangler.local.acceptance.jsonc \
  workers/automation/test-support/wrangler.local.acceptance.jsonc \
  workers/state/wrangler.jsonc
