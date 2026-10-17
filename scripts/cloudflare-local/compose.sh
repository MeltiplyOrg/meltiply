#!/usr/bin/env bash
# Single Compose boundary for the Cloudflare-local stack.
#
# Every caller runs the same command line: the baseline
# compose.dev.yml, plus the devcontainer overlay when
# MELTIPLY_DEVCONTAINER=1. The overlay (default .devcontainer/compose.yml,
# overridable through MELTIPLY_DEVCONTAINER_CONFIG so launcher-staged config
# works outside the checkout) moves every service into the owning
# devcontainer's network namespace via network_mode: container:<id>. That id
# is resolved from the exact meltiply.devcontainer.project=$COMPOSE_PROJECT_NAME
# label the owner carries — never the hostname or container name, which the
# launcher overrides with a branch hostname and a docker rename — and
# COMPOSE_PROJECT_NAME (injected by the devcontainer) must keep sibling
# devcontainer projects disjoint. Without the overlay, Compose's own
# name:/COMPOSE_PROJECT_NAME resolution decides the project, which keeps
# host-native workflows on the shared meltiply-cloudflare stack.
#
# All arguments are forwarded verbatim to `docker compose`, so callers keep
# full CLI access (up/down/exec/config/...) through one seam.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base_file="$repo_root/compose.dev.yml"

compose=(-f "$base_file")

# Prints the full container ID of the devcontainer that owns this project.
#
# Ownership is the meltiply.devcontainer.project=$COMPOSE_PROJECT_NAME label
# applied at container creation; it survives the branch --hostname and the
# daemon-side rename the launcher performs, so no name or hostname source can
# resolve a sibling. Exactly one running container may carry the label: zero
# means the environment contract is broken, and more than one means the label
# was applied to something that is not this devcontainer — both are fatal
# rather than a guess. --no-trunc keeps the returned ID directly usable by the
# overlay's network_mode interpolation.
#
# @return 0 and print the full container ID; 1 after reporting that the owning
#         devcontainer is missing or ambiguous through the daemon.
devcontainer_id() {
  local owners
  if ! owners="$(docker ps -q --no-trunc \
    --filter "label=meltiply.devcontainer.project=${COMPOSE_PROJECT_NAME}")"; then
    printf 'compose.sh: docker ps failed resolving owning devcontainer\n' >&2
    return 1
  fi
  local count
  count="$(printf '%s\n' "$owners" | grep -c . || true)"
  if [[ "$count" != "1" ]]; then
    printf 'compose.sh: expected exactly one running owner labeled meltiply.devcontainer.project=%s, found %s\n' \
      "$COMPOSE_PROJECT_NAME" "$count" >&2
    return 1
  fi
  printf '%s\n' "$owners"
}

# A devcontainer invocation needs the overlay plus both injected identities:
# COMPOSE_PROJECT_NAME scopes containers/volumes/networks to this devcontainer
# and selects the owner, and HOSTNAME must be exported as that owner's real
# container ID so the overlay's network_mode interpolation resolves. Any
# missing piece would silently fall back to the shared baseline stack or to
# the base project name, which is how one devcontainer's teardown could reap a
# sibling's resources — fail closed.
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
  # Split assignment/export so a devcontainer_id failure cannot be masked by
  # export's builtin success; only the label-verified ID reaches the overlay.
  HOSTNAME="$(devcontainer_id)"
  export HOSTNAME
  compose+=(-f "$overlay_file")
fi

exec docker compose "${compose[@]}" "$@"
