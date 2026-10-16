#!/usr/bin/env bash
# Create the directories the devcontainer bind-mounts from the host. A missing
# source makes Docker create it as root, which dev could not write inside.
# The image is pulled, not built: nothing else needs preparing here.
set -euo pipefail

mkdir -p "$HOME/.config/.wrangler"
