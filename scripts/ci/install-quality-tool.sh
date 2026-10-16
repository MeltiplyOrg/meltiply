#!/usr/bin/env bash
# Installs one pinned Linux quality tool for CircleCI or GitHub-hosted runners.
# Release digests are pinned here, not fetched alongside an unverified archive.
set -euo pipefail

case "${1:-}:$(uname -m)" in
  gitleaks:x86_64 | gitleaks:amd64)
    tool=gitleaks version=8.30.1 archive=gitleaks_8.30.1_linux_x64.tar.gz
    digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  gitleaks:aarch64 | gitleaks:arm64)
    tool=gitleaks version=8.30.1 archive=gitleaks_8.30.1_linux_arm64.tar.gz
    digest=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
    ;;
  typos:x86_64 | typos:amd64)
    tool=typos version=1.35.5 archive=typos-v1.35.5-x86_64-unknown-linux-musl.tar.gz
    digest=723da6dad9662a0a50725b9d96a48a55801ae5d60852705e878d280abe354c76
    ;;
  typos:aarch64 | typos:arm64)
    tool=typos version=1.35.5 archive=typos-v1.35.5-aarch64-unknown-linux-musl.tar.gz
    digest=95d9e34fdae0ffb074eac4158c8ea8202a6759a585429e99848934997a6128b3
    ;;
  *) echo "Usage: install-quality-tool.sh gitleaks|typos (Linux x64/arm64)" >&2; exit 2 ;;
esac
[[ "$(uname -s)" == Linux ]] || { echo "Linux is required" >&2; exit 2; }
bin_dir="${QUALITY_TOOL_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
case "$tool" in
  gitleaks) url="https://github.com/gitleaks/gitleaks/releases/download/v$version/$archive" ;;
  typos) url="https://github.com/crate-ci/typos/releases/download/v$version/$archive" ;;
esac
curl --fail --silent --show-error --location "$url" --output "$temporary/$archive"
printf '%s  %s\n' "$digest" "$temporary/$archive" | sha256sum --check
tar -xzf "$temporary/$archive" -C "$temporary" --no-same-owner
install -m 755 "$temporary/$tool" "$bin_dir/$tool"
if [[ "$tool" == gitleaks ]]; then
  "$bin_dir/$tool" version
else
  "$bin_dir/$tool" --version
fi
