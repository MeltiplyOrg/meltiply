#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fixtures=$(mktemp -d)
trap 'rm -rf "$fixtures"' EXIT

assert_spelling() {
  local name=$1 filename=$2 text=$3 expected=$4
  local directory="$fixtures/$name" status=0
  mkdir -p "$directory"
  printf '%s\n' "$text" > "$directory/$filename"
  typos --config "$repo_root/.typos.toml" "$directory/$filename" \
    > "$directory/check.log" 2>&1 || status=$?
  if [ "$status" -ne "$expected" ]; then
    printf '%s: expected exit %s, got %s\n' "$name" "$expected" "$status" >&2
    tail -n 30 "$directory/check.log" >&2
    exit 1
  fi
}

german_january=$(printf '\112\141\156\165\141\162')
german_october=$(printf '\117\153\164\157\142\145\162')
misspelling=$(printf '\164\145\150')
assert_spelling schedule-month schedule-date-time.test.tsx "$german_january 2028" 0
assert_spelling calendar-month calendar-date-detail-dialog.test.tsx "$german_october 2026" 0
assert_spelling other-file other.test.tsx "$german_january $german_october" 2
assert_spelling other-month schedule-date-time.test.tsx "$german_october 2026" 2
assert_spelling other-misspelling schedule-date-time.test.tsx "$misspelling $german_january 2028" 2
printf 'Localization spelling isolation passed.\n'
