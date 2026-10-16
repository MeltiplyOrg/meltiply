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

# A clean public snapshot has a root commit with no parent. Scan that commit
# directly instead of constructing the invalid HEAD^..HEAD revision range.
# Scan only commits introduced by the current pipeline. Feature branches use
# the branch point on master; the default branch scans only its checked-out
# commit. Every commit in either range is inspected, so a secret added and
# later removed inside a multi-commit feature branch is still caught.
# Public CI opts into all fetched branches/tags plus HEAD; the same live canary
# must pass in both modes so an ineffective scanner cannot report success.
scan_args=(detect --config .gitleaks.toml --redact)
if [ "${1:-}" = "--all-history" ]; then
  range="--all"
elif [ -n "${CIRCLE_BRANCH:-}" ] && [ "$CIRCLE_BRANCH" != "master" ] &&
  git rev-parse -q --verify origin/master >/dev/null; then
  range="origin/master..${CIRCLE_SHA1:-HEAD}"
else
  revision="${CIRCLE_SHA1:-HEAD}"
  if git rev-parse --verify "${revision}^" >/dev/null 2>&1; then
    range="${revision}^..${revision}"
  else
    range="$revision"
  fi
fi
echo "secret scan: $range"
scan_args+=(--log-opts="$range")
gitleaks "${scan_args[@]}"
