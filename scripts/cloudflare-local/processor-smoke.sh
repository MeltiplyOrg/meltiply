#!/usr/bin/env bash
# Runs the native media processor engine smoke against a real container.
#
# The engine image (workers/automation/processor/Dockerfile) is the actual
# FFmpeg/ffprobe + libvips runtime the deployed Asset processor uses. This script
# only establishes the prerequisites the engine image imposes — a reachable
# Docker daemon and, on non-amd64 hosts, amd64 emulation — and then delegates to
# the workspace script that builds the image, generates fixtures with the image's
# own binaries, and asserts the processed output.
#
# Pass-through arguments reach the workspace script unchanged, e.g.
#   scripts/cloudflare-local/processor-smoke.sh --keep-image
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=container-runtime.sh
source "$repo_root/scripts/cloudflare-local/container-runtime.sh"
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"
load_local_env "$repo_root/.env"

# Stops before any image build when this host cannot execute the engine image.
require_container_runtime 'the media processor engine smoke'

printf 'processor smoke: running the engine smoke on %s\n' \
  "$(container_image_platform)" >&2

cd "$repo_root"
exec "${BUN:-bun}" run --no-install --filter @meltiply/automation-worker \
  smoke:processor "$@"