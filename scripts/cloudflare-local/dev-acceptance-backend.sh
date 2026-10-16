#!/usr/bin/env bash
# Boots the local backend for browser acceptance runs of Post publication.
#
# Same session as `dev-backend.sh` in every environment and networking respect —
# `launch_local_wrangler_backend` keeps the database, `.env`, container-runtime,
# and pinned local S3 endpoint setup identical — with two differences: the API
# and Automation Workers start from their `test-support` acceptance entries
# instead of their production `src` entries, and the container policy is
# `required` so WRANGLER_DEV_ENABLE_CONTAINERS=false is rejected outright. The
# test-support entries are the production entry points with the controlled
# external Provider injected through the existing `providerRegistry` dependency
# slot, so a publication still travels the real outbox, queue, lease,
# publication-snapshot, media-resolution, and outcome-recording path — only the
# platform on the far side of the boundary is the controlled fixture.
#
# The OAuth state Worker is the unmodified production config: the acceptance API
# entry binds the very same `OAUTH_STATE` Durable Object.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=wrangler-env.sh
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"

launch_local_wrangler_backend "$repo_root" required \
  'the acceptance media processor' 'Acceptance Worker backend' \
  workers/api/test-support/wrangler.local.acceptance.jsonc \
  workers/automation/test-support/wrangler.local.acceptance.jsonc \
  workers/state/wrangler.jsonc
