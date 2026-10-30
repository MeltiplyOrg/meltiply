#!/usr/bin/env bash
# Single Compose boundary for the Cloudflare-local stack.
#
# Devcontainers add an overlay using the inner daemon's host network (the
# devcontainer itself). Native workflows retain the baseline Compose network.
# COMPOSE_PROJECT_NAME keeps lifecycle cleanup scoped in either environment.
#
# All arguments are forwarded verbatim to `docker compose`, so callers keep
# full CLI access (up/down/exec/config/...) through one seam.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base_file="$repo_root/compose.dev.yml"

compose=(-f "$base_file")

if [[ "${MELTIPLY_DEVCONTAINER:-0}" == "1" ]]; then
  overlay_file="${MELTIPLY_DEVCONTAINER_CONFIG:-$repo_root/.devcontainer}/compose.yml"
  if [[ ! -f "$overlay_file" ]]; then
    printf 'compose.sh: MELTIPLY_DEVCONTAINER=1 but overlay missing: %s\n' "$overlay_file" >&2
    exit 1
  fi
  if [[ -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
    printf 'compose.sh: MELTIPLY_DEVCONTAINER=1 requires COMPOSE_PROJECT_NAME\n' >&2
    exit 1
  fi
  compose+=(-f "$overlay_file")
fi

exec docker compose "${compose[@]}" "$@"
