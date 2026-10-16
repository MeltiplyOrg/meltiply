#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Generation must reflect only checked-in Worker configs. Wrangler reads the
# neighbouring `.dev.vars`/`.env` files and process environment on every run,
# so the declarations are produced inside a private session mirror that masks
# checkout env files instead of loading them here.
exec node "$repo_root/scripts/cloudflare-local/worker-types.mjs"
