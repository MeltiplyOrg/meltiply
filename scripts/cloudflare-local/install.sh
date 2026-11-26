#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

required_node="$(cat .node-version)"
required_bun=1.4.2

fail() {
  printf '[install] %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 ||
  fail "curl is required to install Bun and OpenTofu"

node_version="$(node --version 2>/dev/null || true)"
[[ "$node_version" == "v$required_node" ]] ||
  fail "Node v$required_node is required (found: ${node_version:-none}); install it with your version manager, see .node-version"

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

CI=true ./scripts/cloudflare-local/setup.sh

(cd frontend/app && bun run --no-install playwright install chromium)

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
