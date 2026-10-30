#!/usr/bin/env bash
# Prepare host-side Wrangler state before bind mounting it, then build the
# startup image. The CLI must inspect the finished image: a build: config instead
# merges metadata from FROM and restores the upstream host-socket mount.
# Docker caches the wrapper; the toolchain is inherited without being copied.
set -euo pipefail

mkdir -p "$HOME/.config/.wrangler"
docker build --tag meltiply-devcontainer-dind:local "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
