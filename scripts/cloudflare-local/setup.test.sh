#!/usr/bin/env bash
set -euo pipefail

# These Docker fixtures model host-mode Compose, not the editor's devcontainer.
# Keep inherited topology from requesting an owner absent from the fixture.
unset MELTIPLY_DEVCONTAINER

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT HUP INT TERM

mkdir -p \
  "$fixture/bin" \
  "$fixture/scripts/infra" \
  "$fixture/scripts/cloudflare-local"

cat >"$fixture/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '1.4.2\n'
  exit 0
fi
printf 'bun %s\n' "$*" >>"$COMMAND_LOG"
EOF

cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
EOF

cat >"$fixture/scripts/infra/install-opentofu.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'install-opentofu\n' >>"$COMMAND_LOG"
EOF

# setup.sh pulls images through the real shared boundary; give the fixture
# checkout the real helper so the call shape matches production.
cp "$repo_root/scripts/cloudflare-local/compose.sh" \
  "$fixture/scripts/cloudflare-local/compose.sh"
cp "$repo_root/scripts/cloudflare-local/complete-env.mjs" \
  "$fixture/scripts/cloudflare-local/complete-env.mjs"

cat >"$fixture/scripts/cloudflare-local/database.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'database %s\n' "$*" >>"$COMMAND_LOG"
EOF

chmod +x \
  "$fixture/bin/bun" \
  "$fixture/bin/docker" \
  "$fixture/scripts/infra/install-opentofu.sh" \
  "$fixture/scripts/cloudflare-local/compose.sh" \
  "$fixture/scripts/cloudflare-local/database.sh"

cat >"$fixture/.env.example" <<'EOF'
APP_URL=http://localhost:8787
EOF

assert_logged() {
  local expected=$1
  if ! grep -Fxq "$expected" "$COMMAND_LOG"; then
    printf 'expected command was not run: %s\n' "$expected" >&2
    printf 'command log:\n' >&2
    cat "$COMMAND_LOG" >&2
    exit 1
  fi
}

assert_not_logged() {
  local unexpected=$1
  if grep -Fxq "$unexpected" "$COMMAND_LOG"; then
    printf 'unexpected command was run: %s\n' "$unexpected" >&2
    printf 'command log:\n' >&2
    cat "$COMMAND_LOG" >&2
    exit 1
  fi
}

export COMMAND_LOG="$fixture/commands.log"
export PATH="$fixture/bin:$PATH"

: >"$COMMAND_LOG"
(
  cd "$fixture"
  "$repo_root/scripts/cloudflare-local/setup.sh"
)
assert_logged "bun install --frozen-lockfile"
assert_logged "install-opentofu"
grep -Fq 'pull postgres' "$COMMAND_LOG" ||
  { echo "expected a postgres image pull" >&2; cat "$COMMAND_LOG" >&2; exit 1; }
assert_logged "database seed"

cp "$fixture/.env" "$fixture/first-setup.env"
: >"$COMMAND_LOG"
(
  cd "$fixture"
  "$repo_root/scripts/cloudflare-local/setup.sh" \
    --skip-dependencies \
    --skip-image-pull
)
assert_not_logged "bun install --frozen-lockfile"
assert_not_logged "install-opentofu"
if grep -Fq 'pull postgres' "$COMMAND_LOG"; then
  echo "--skip-image-pull still pulled postgres" >&2
  cat "$COMMAND_LOG" >&2
  exit 1
fi
assert_logged "database seed"
# Re-running setup must preserve generated signing/encryption/bootstrap material.
cmp "$fixture/first-setup.env" "$fixture/.env"

: >"$COMMAND_LOG"
if (
  cd "$fixture"
  "$repo_root/scripts/cloudflare-local/setup.sh" --unknown-option
) >"$fixture/unknown.stdout" 2>"$fixture/unknown.stderr"; then
  echo "setup accepted an unknown option" >&2
  exit 1
fi
grep -Fq "unknown option: --unknown-option" "$fixture/unknown.stderr"
if [[ -s "$COMMAND_LOG" ]]; then
  echo "setup performed work before rejecting an unknown option" >&2
  exit 1
fi


# A cold PostgreSQL volume briefly becomes ready during image initialization,
# then restarts before the final server. Migration must wait through that gap.
cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
case " $* " in
  *" exec -T postgres pg_isready "*)
    count="$(cat "$PG_READY_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$PG_READY_COUNT"
    [[ "$count" -ne 2 ]]
    ;;
  *" exec -T postgres test -f "*)
    exit 0
    ;;
  *" exec -T postgres /local/migrate.sh "*)
    [[ "$(cat "$PG_READY_COUNT")" -ge 5 ]]
    touch "$MIGRATION_RAN"
    ;;
esac
EOF
cat >"$fixture/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fixture/bin/docker" "$fixture/bin/sleep"
export PG_READY_COUNT="$fixture/pg-ready-count"
export MIGRATION_RAN="$fixture/migration-ran"
printf '0\n' >"$PG_READY_COUNT"
"$repo_root/scripts/cloudflare-local/database.sh" start
[[ "$(cat "$PG_READY_COUNT")" == "5" ]]
[[ -f "$MIGRATION_RAN" ]]

printf 'cloudflare local setup tests passed\n'
