#!/usr/bin/env bash
# Hermetic checks for shared-runner teardown behavior.
set -euo pipefail

# Baseline cases model a host checkout; later cases inject container identity.
# Never inherit a real stack's topology or CI cleanup handles into the fixture.
unset COMPOSE_PROJECT_NAME MELTIPLY_DEVCONTAINER MELTIPLY_DEVCONTAINER_CONFIG \
  MELTIPLY_TEARDOWN_DOCKER_READY MELTIPLY_CI_KEEP_LOCK \
  MELTIPLY_CI_CLEANUP_MARKER MELTIPLY_CI_LOCK_RELEASE MELTIPLY_CI_LOCK_HOLDER \
  STUB_LISTENER_PID

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
leaked_pid=
port_pid=
# Reap only fixture-owned process groups, including failures in the port case.
cleanup_fixture() {
  local pid
  for pid in "${leaked_pid:-}" "${port_pid:-}"; do
    if [[ -n "$pid" ]]; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$fixture"
}
trap cleanup_fixture EXIT HUP INT TERM

repo_fixture="$fixture/ci-workspaces/current"
mkdir -p "$fixture/bin" "$repo_fixture/scripts/cloudflare-local" \
  "$repo_fixture/.devcontainer"
cp "$repo_root/scripts/cloudflare-local/teardown.sh" \
  "$repo_fixture/scripts/cloudflare-local/teardown.sh"
# teardown routes every Compose call through the shared boundary, so the
# fixture checkout needs the real helper plus the devcontainer overlay it
# requires under MELTIPLY_DEVCONTAINER=1.
cp "$repo_root/scripts/cloudflare-local/compose.sh" \
  "$repo_fixture/scripts/cloudflare-local/compose.sh"
printf 'services: {}\n' >"$repo_fixture/.devcontainer/compose.yml"
chmod +x \
  "$repo_fixture/scripts/cloudflare-local/teardown.sh" \
  "$repo_fixture/scripts/cloudflare-local/compose.sh"

cat >"$repo_fixture/compose.dev.yml" <<'EOF'
name: meltiply-cloudflare
services:
  postgres:
    image: postgres:18.6-alpine
EOF

# Docker stub backed by a daemon resource table (RESOURCES, pipe-delimited:
# container|id|name|image|compose-project|devcontainer-project,
# volume|name|project). It honors real filter semantics — compose label
# filters match the recorded compose project, the devcontainer owner label
# filter matches the recorded devcontainer project, name filters match by
# substring exactly like the daemon, ancestor filters match the recorded
# image — so an unscoped sweep returns foreign resources and this suite can
# prove teardown never queries or removes them. `down` prunes only the
# resolved project's own rows; STUB_DOWN_NOOP=1 simulates a `down` that
# leaves leftovers behind for the label-scoped force-remove path.
cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"${COMMAND_LOG:?}"
res="${RESOURCES:?}"
[[ -f $res ]] || : >"$res"

# Prints container IDs from the resource table matching every filter arg.
# Docker ANDs repeated filters; each kind is applied against its table field,
# including the devcontainer owner label keyed off the sixth column.
emit_containers() {
  local filters=()
  while (($#)); do
    case "$1" in
      --filter | -f) filters+=("${2:-}"); shift 2 ;;
      --filter=* | -f=*) filters+=("${1#*=}"); shift ;;
      *) shift ;;
    esac
  done
  local kind id name image proj dcp filt ok
  while IFS='|' read -r kind id name image proj dcp; do
    [[ $kind == container ]] || continue
    ok=1
    for filt in ${filters[@]+"${filters[@]}"}; do
      [[ -n $filt ]] || continue
      case "$filt" in
        label=com.docker.compose.project=*) [[ $proj == "${filt##*=}" ]] || ok=0 ;;
        label=meltiply.devcontainer.project=*) [[ $dcp == "${filt##*=}" ]] || ok=0 ;;
        name=*) [[ $name == *"${filt#name=}"* ]] || ok=0 ;;
        ancestor=*) [[ $image == "${filt#ancestor=}" ]] || ok=0 ;;
      esac
    done
    if ((ok)); then printf '%s\n' "$id"; fi
  done <"$res"
}

# Prints matching volume names from three-column kind|name|project rows.
# The label lives in column three, unlike the five-column container records.
emit_volumes() {
  local filters=()
  while (($#)); do
    case "$1" in
      --filter | -f) filters+=("${2:-}"); shift 2 ;;
      --filter=* | -f=*) filters+=("${1#*=}"); shift ;;
      *) shift ;;
    esac
  done
  local kind id proj rest filt ok
  while IFS='|' read -r kind id proj rest; do
    [[ $kind == volume ]] || continue
    ok=1
    for filt in ${filters[@]+"${filters[@]}"}; do
      [[ -n $filt ]] || continue
      case "$filt" in
        label=com.docker.compose.project=*) [[ $proj == "${filt##*=}" ]] || ok=0 ;;
        name=*) [[ $id == *"${filt#name=}"* ]] || ok=0 ;;
      esac
    done
    if ((ok)); then printf '%s\n' "$id"; fi
  done <"$res"
}

# Deletes only the rows whose IDs the caller selected; nothing else is
# touched, so a wrongly scoped query is the only way foreign rows disappear.
remove_rows() {
  local kind=$1
  shift
  local arg
  for arg in "$@"; do
    [[ $arg == -* ]] && continue
    awk -F'|' -v k="$kind" -v id="$arg" '!($1==k && $2==id)' \
      "$res" >"$res.tmp" && mv "$res.tmp" "$res"
  done
}

cmd="${1:-}"
(($#)) && shift
case "$cmd" in
  info)
    exit 0
    ;;
  inspect)
    printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
    exit 0
    ;;
  compose)
    for a in "$@"; do
      [[ $a == down ]] || continue
      # Resolve the project exactly like compose: -p wins, then the
      # environment, then the file's declared name (the fixture uses the same
      # baseline name). Remove only rows labeled with that project.
      local_proj="${COMPOSE_PROJECT_NAME:-meltiply-cloudflare}"
      skip=0
      for a in "$@"; do
        case "$a" in
          -p | --project-name) skip=1 ;;
          --project-name=*) local_proj="${a#--project-name=}" ;;
          *) if ((skip)); then local_proj="$a"; skip=0; fi ;;
        esac
      done
      if [[ "${STUB_DOWN_NOOP:-0}" != "1" ]]; then
        awk -F'|' -v p="$local_proj" \
          '!(($1=="container"&&$5==p)||($1=="volume"&&$3==p))' \
          "$res" >"$res.tmp" && mv "$res.tmp" "$res"
      fi
      exit 0
    done
    exit 0
    ;;
  ps)
    emit_containers "$@"
    exit 0
    ;;
  volume)
    sub="${1:-}"
    (($#)) && shift
    case "$sub" in
      ls) emit_volumes "$@" ;;
      rm) remove_rows volume "$@" ;;
    esac
    exit 0
    ;;
  rm)
    remove_rows container "$@"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$fixture/bin/docker"

# Keep real port listeners and generic tunnel/processor process matches out of
# this hermetic suite. Only fixture-rooted patterns reach the native pgrep.
export TEARDOWN_FIXTURE_ROOT="$fixture"
TEARDOWN_REAL_PGREP="$(command -v pgrep)"
export TEARDOWN_REAL_PGREP
cat >"$fixture/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${2:-}" == "${TEARDOWN_FIXTURE_ROOT:?}/"* ]]; then
  exec "${TEARDOWN_REAL_PGREP:?}" "$@"
fi
exit 1
EOF
cat >"$fixture/bin/ss" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${STUB_LISTENER_PID:-}" ]]; then
  printf 'LISTEN 0 128 127.0.0.1:8787 0.0.0.0:* users:(("workerd",pid=%s,fd=13))\n' "$STUB_LISTENER_PID"
fi
EOF
chmod +x "$fixture/bin/pgrep" "$fixture/bin/ss"

export PATH="$fixture/bin:$PATH"
export COMMAND_LOG="$fixture/commands.log"
export RESOURCES="$fixture/resources.tsv"

# Seeds one daemon table holding two sibling projects plus resources that only
# an unsafe query would reach: a name-prefix sibling (meltiply-cloudflare-2,
# matched by any loose name= filter), processor containers from both projects
# (matched by any ancestor= sweep), and the devcontainer owners that carry the
# meltiply.devcontainer.project label — the identity compose.sh resolves under
# MELTIPLY_DEVCONTAINER=1. Neither owner belongs to a Compose project (empty
# column five), so no project-scoped down or sweep may ever reap them.
seed_resources() {
  cat >"$RESOURCES" <<'EOF'
container|c-own-postgres|meltiply-cloudflare-postgres-1|postgres18|meltiply-cloudflare|
container|c-own-tempo|meltiply-cloudflare-tempo-1|tempo3|meltiply-cloudflare|
container|c-proc-own|meltiply-cloudflare-run-1|cloudflare-dev/mediaprocessorcontainer|meltiply-cloudflare|
container|c-foreign|meltiply-deadbeef-postgres-1|postgres18|meltiply-deadbeef|
container|c-prefix-sib|meltiply-cloudflare-2-postgres-1|postgres18|meltiply-cloudflare-2|
container|c-proc-foreign|meltiply-deadbeef-run-1|cloudflare-dev/mediaprocessorcontainer|meltiply-deadbeef|
container|c-owner-deadbeef|meltiply-deadbeef|devcontainer-image1||meltiply-deadbeef
container|c-owner-cafebabe|meltiply-cafebabe|devcontainer-image1||meltiply-cafebabe
volume|meltiply-cloudflare_postgres|meltiply-cloudflare
volume|meltiply-deadbeef_postgres|meltiply-deadbeef
EOF
}

# Asserts a resource row is absent from the daemon table after teardown.
assert_removed() {
  if grep -Fq "$1" "$RESOURCES"; then
    echo "resource should have been removed: $1" >&2
    cat "$RESOURCES" >&2
    exit 1
  fi
}

# Asserts a resource row survived teardown.
assert_kept() {
  if ! grep -Fq "$1" "$RESOURCES"; then
    echo "resource wrongly removed: $1" >&2
    cat "$RESOURCES" >&2
    exit 1
  fi
}

# Run 1: `down` clears every own-project resource; nothing needs force-rm.
seed_resources
: >"$COMMAND_LOG"
(
  cd "$repo_fixture"
  ./scripts/cloudflare-local/teardown.sh
) >"$fixture/stdout" 2>"$fixture/stderr"

for id in c-own-postgres c-own-tempo c-proc-own; do
  assert_removed "$id"
done
assert_removed 'meltiply-cloudflare_postgres'
for id in c-foreign c-prefix-sib c-proc-foreign c-owner-deadbeef c-owner-cafebabe; do
  assert_kept "$id"
done
assert_kept 'meltiply-deadbeef_postgres'
# Bound docker call count — protect against EMFILE regressions.
calls="$(grep -c '^docker ' "$COMMAND_LOG" || true)"
if [[ "$calls" -gt 12 ]]; then
  echo "too many docker calls ($calls); teardown must stay FD-cheap" >&2
  cat "$COMMAND_LOG" >&2
  exit 1
fi

# Run 2: `down` leaves leftovers behind → the label-scoped force-remove path
# must reap only this project's rows.
seed_resources
: >"$COMMAND_LOG"
(
  cd "$repo_fixture"
  env STUB_DOWN_NOOP=1 ./scripts/cloudflare-local/teardown.sh
) >"$fixture/stdout2" 2>"$fixture/stderr2"

for id in c-own-postgres c-own-tempo c-proc-own; do
  assert_removed "$id"
done
assert_removed 'meltiply-cloudflare_postgres'
for id in c-foreign c-prefix-sib c-proc-foreign c-owner-deadbeef c-owner-cafebabe; do
  assert_kept "$id"
done
assert_kept 'meltiply-deadbeef_postgres'
calls="$(grep -c '^docker ' "$COMMAND_LOG" || true)"
if [[ "$calls" -gt 12 ]]; then
  echo "too many docker calls on force-remove path ($calls)" >&2
  cat "$COMMAND_LOG" >&2
  exit 1
fi

# Run 3: a devcontainer teardown is bound to its own COMPOSE_PROJECT_NAME.
# meltiply-deadbeef shares the meltiply- prefix with the baseline project and
# carries its own processor container, so any unscoped down, name filter, or
# ancestor sweep would visibly reap baseline rows from the table. compose.sh
# resolves the owner through the meltiply.devcontainer.project label — the
# seeded meltiply-cafebabe owner proves an exact label match cannot select a
# sibling, and both owners must survive teardown.
seed_resources
: >"$COMMAND_LOG"
(
  cd "$repo_fixture"
  env MELTIPLY_DEVCONTAINER=1 COMPOSE_PROJECT_NAME=meltiply-deadbeef \
    STUB_DOWN_NOOP=1 ./scripts/cloudflare-local/teardown.sh
) >"$fixture/stdout3" 2>"$fixture/stderr3"

for id in c-foreign c-proc-foreign; do
  assert_removed "$id"
done
assert_removed 'meltiply-deadbeef_postgres'
for id in c-own-postgres c-own-tempo c-proc-own c-prefix-sib c-owner-deadbeef c-owner-cafebabe; do
  assert_kept "$id"
done
assert_kept 'meltiply-cloudflare_postgres'

# Run 4: devcontainer without COMPOSE_PROJECT_NAME must fail closed — nonzero
# exit and zero docker calls, before any cleanup can reach the daemon.
: >"$COMMAND_LOG"
if (
  cd "$repo_fixture"
  env -u COMPOSE_PROJECT_NAME MELTIPLY_DEVCONTAINER=1 \
    ./scripts/cloudflare-local/teardown.sh
) >"$fixture/stdout4" 2>"$fixture/stderr4"; then
  echo "teardown ran in a devcontainer without COMPOSE_PROJECT_NAME" >&2
  exit 1
fi
if [[ -s "$COMMAND_LOG" ]]; then
  echo "teardown touched docker after failing identity validation" >&2
  cat "$COMMAND_LOG" >&2
  exit 1
fi

# A leak from a sibling CI checkout must be reaped by this checkout's teardown.
leaked_path="$fixture/ci-workspaces/previous/node_modules/.bin/wrangler"
setsid bash -c 'exec -a "$1" sleep 30' _ "$leaked_path" &
leaked_pid=$!
matched=0
for _ in $(seq 1 10); do
  if pgrep -f "$fixture/ci-workspaces/.*/wrangler" >/dev/null 2>&1; then
    matched=1
    break
  fi
  sleep 0.1
done
if [[ "$matched" != "1" ]]; then
  echo "failed to start sibling-workspace wrangler fixture" >&2
  exit 1
fi
(
  cd "$repo_fixture"
  ./scripts/cloudflare-local/teardown.sh
) >/dev/null
if kill -0 "$leaked_pid" 2>/dev/null; then
  echo "teardown left sibling-workspace wrangler running" >&2
  exit 1
fi
wait "$leaked_pid" 2>/dev/null || true
leaked_pid=

# A wedged listener on a fixed stack port (argv no longer matching wrangler/
# workerd) must still be reaped by the port-based net.
setsid bash -c 'exec -a /tmp/wedged-listener sleep 30' &
port_pid=$!
(
  cd "$repo_fixture"
  STUB_LISTENER_PID="$port_pid" ./scripts/cloudflare-local/teardown.sh
) >/dev/null
if kill -0 "$port_pid" 2>/dev/null; then
  echo "teardown left wedged stack-port listener running" >&2
  exit 1
fi
wait "$port_pid" 2>/dev/null || true
port_pid=

# Teardown must disarm the cancellation trap before doing Docker work.
marker="$fixture/cloudflare-active"
touch "$marker"
(
  export MELTIPLY_CI_CLEANUP_MARKER="$marker"
  cd "$repo_fixture"
  ./scripts/cloudflare-local/teardown.sh
) >/dev/null
if [[ -e "$marker" ]]; then
  echo "teardown left cancellation marker armed" >&2
  exit 1
fi
printf 'cloudflare local teardown tests passed\n'
