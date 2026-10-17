#!/usr/bin/env bash
# Create the directory bind-mounted for Wrangler configuration. A missing host
# source makes Docker create it as root, which the dev user cannot write inside.
set -euo pipefail

mkdir -p "$HOME/.config/.wrangler"
