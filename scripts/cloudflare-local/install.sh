#!/usr/bin/env bash
# Bootstrap the full local toolchain and dependency set for the Cloudflare-target
# stack, then verify the result with doctor.sh.
#
# Layers:
#   1. Toolchain   Node (check only, .node-version), Bun 1.4.2 (installed when
#                  missing or mismatched), Docker + Compose (check only), curl
#   2. Setup       delegates to setup.sh: workspace deps, OpenTofu, .env files,
#                  compose image pull, PostgreSQL start + migrations
#   3. Workspaces  per-member node_modules check, Playwright Chromium runtime
#   4. Verify      doctor.sh; a degraded live stack (exit 2) is expected because
#                  `make install` does not start the dev servers
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

required_node="$(cat .node-version)"
required_bun=1.4.2

# fail prints one actionable line and aborts; used for prerequisites this
# script cannot safely install itself (Node, Docker).
fail() {
  printf '[install] %s\n' "$1" >&2
  exit 1
}

# --- toolchain ----------------------------------------------------------------

command -v curl >/dev/null 2>&1 ||
  fail "curl is required to install Bun and OpenTofu"

node_version="$(node --version 2>/dev/null || true)"
[[ "$node_version" == "v$required_node" ]] ||
  fail "Node v$required_node is required (found: ${node_version:-none}); install it with your version manager, see .node-version"

# Bun is installed rather than checked because the pinned release has a
# canonical installer; ~/.bun/bin is prepended so a stale Bun earlier on PATH
# cannot shadow the pinned one for the rest of this run.
if [[ "$(bun --version 2>/dev/null || true)" != "$required_bun" ]]; then
  printf '[install] Installing Bun %s\n' "$required_bun"
  curl --proto '=https' --tlsv1.2 -fsSL https://bun.sh/install |
    bash -s "bun-v$required_bun"
  export PATH="$HOME/.bun/bin:$PATH"
fi
[[ "$(bun --version 2>/dev/null || true)" == "$required_bun" ]] ||
  fail "Bun $required_bun is not on PATH after install; add ~/.bun/bin to PATH and re-run"

docker info >/dev/null 2>&1 ||
  fail "Docker daemon is not reachable; install and start Docker first"
docker compose version >/dev/null 2>&1 ||
  fail "Docker Compose plugin is required; install docker-compose-plugin"

# The media processor runs as a linux/amd64 Cloudflare Container. On a non-amd64
# host that needs QEMU user-mode emulation; without it every other prerequisite
# can be satisfied while media processing still cannot run, so name the remedy
# now rather than at the first failed upload.
# shellcheck source=container-runtime.sh
source scripts/cloudflare-local/container-runtime.sh
if ! container_emulation_ready; then
  printf '[install] Warning: this %s host cannot run %s container images.\n' \
    "$(uname -m)" "$(container_image_platform)"
  printf '[install] %s\n' "$(container_emulation_hint)"
fi

# --- repository setup ---------------------------------------------------------

CI=true ./scripts/cloudflare-local/setup.sh

# --- e2e browser runtime ------------------------------------------------------

(cd frontend/app && bun run --no-install playwright install chromium)

# --- workspace dependencies ---------------------------------------------------

# The root `bun install` in setup.sh already installs every workspace member,
# but a fresh checkout can skip it via --skip-dependencies or a partial run.
# Verify each member's node_modules explicitly so `make install` alone is
# sufficient; bun resolves the workspace root and installs only what is missing.
# The glob list mirrors the `workspaces` field in package.json.
for member_dir in frontend/* packages/* workers/*; do
  case "$member_dir" in */node_modules) continue ;; esac
  if [[ -d "$member_dir" && ! -d "$member_dir/node_modules" ]]; then
    printf '[install] Installing %s dependencies\n' "$member_dir"
    (cd "$member_dir" && bun install)
  fi
done

# --- verify -------------------------------------------------------------------

status=0
./scripts/cloudflare-local/doctor.sh || status=$?
case "$status" in
  0) ;;
  2)
    printf '\n[install] Toolchain and repository healthy; live stack not started (expected).\n'
    ;;
  *) exit "$status" ;;
esac

printf '\n[install] Done. Run `make dev` to start the development stack.\n'
