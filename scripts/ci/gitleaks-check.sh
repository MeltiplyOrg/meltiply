#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--all-history" ]; }; then
  echo "Usage: gitleaks-check.sh [--all-history]" >&2
  exit 2
fi

canary_prefix='xoxb-'
canary_marker='123456789012-'
canary_body='123456789012-abcdefghijklmnopqrstuvwx'
if printf 'token=%s%s%s\n' "$canary_prefix" "$canary_marker" "$canary_body" \
  | gitleaks detect --pipe --config .gitleaks.toml --no-banner --redact \
    >/dev/null 2>&1; then
  echo "gitleaks canary was not detected" >&2
  exit 1
fi

# Scan every fetched commit and tag, including secrets removed by later commits.
# The live canary above prevents a broken scanner from reporting a false pass.
scan_args=(detect --config .gitleaks.toml --redact)
range="--all"
echo "secret scan: $range"
scan_args+=(--log-opts="$range")
gitleaks "${scan_args[@]}"
