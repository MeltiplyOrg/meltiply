#!/usr/bin/env bash
# Docker creates a missing bind-mount source as root.
set -euo pipefail

mkdir -p "$HOME/.config/.wrangler"
