#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fixtures=$(mktemp -d)
trap 'rm -rf "$fixtures"' EXIT

assert_scan() {
  local name=$1 file=$2 value=$3 expected=$4
  local directory="$fixtures/$name" status=0
  mkdir -p "$directory/$(dirname "$file")"
  git -C "$directory" init -q
  printf 'PROCESSOR_JOB_TOKEN: "%s"\n' "$value" > "$directory/$file"
  git -C "$directory" add .
  git -C "$directory" -c user.name=Fixture -c user.email=fixture@example.test commit -qm fixture
  gitleaks detect --source "$directory" --config "$repo_root/.gitleaks.toml" \
    --log-opts=--all --no-banner --redact --verbose > "$directory/scan.log" 2>&1 || status=$?
  if [ "$status" -ne "$expected" ]; then
    printf '%s: expected exit %s, got %s\n' "$name" "$expected" "$status" >&2
    tail -n 30 "$directory/scan.log" >&2
    exit 1
  fi
}

fixture_path=workers/automation/processor/engine/engine-job.test.mjs
assert_scan exact-fixture "$fixture_path" 0123456789abcdef 0
assert_scan different-value "$fixture_path" fedcba9876543210 1
assert_scan different-path workers/automation/processor/engine/other.test.mjs 0123456789abcdef 1
assert_scan prefixed-value "$fixture_path" prefix0123456789abcdef 1
printf 'Secret-scanner fixture isolation passed.\n'
