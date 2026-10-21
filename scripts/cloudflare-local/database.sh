#!/usr/bin/env bash
set -euo pipefail

# Route every Compose call through the shared boundary so this stack picks up
# the devcontainer overlay and the caller-injected COMPOSE_PROJECT_NAME scope.
compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=("$compose_dir/compose.sh")

# Reports whether the postgres service answers pg_isready inside its Compose
# container; quiet probe used by the readiness loops below.
postgres_ready() {
  "${compose[@]}" exec -T postgres pg_isready -U postgres -d meltiply >/dev/null 2>&1
}
# Waits up to 45s for the first pg_isready success; exits when the container
# never answers so a downed stack fails fast instead of hanging callers.
wait_for_postgres() {
  for _ in $(seq 1 45); do
    if postgres_ready; then
      return
    fi
    sleep 1
  done
  echo "Cloudflare-target PostgreSQL did not become ready" >&2
  exit 1
}
# Requires three consecutive pg_isready successes before returning. A cold
# volume passes a transient ready state while the image's temporary init
# server is up, so a single probe can report ready for a server that is about
# to restart.
wait_for_stable_postgres() {
  local consecutive=0
  for _ in $(seq 1 45); do
    if postgres_ready; then
      ((consecutive += 1))
      if ((consecutive >= 3)); then
        return
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo "Cloudflare-target PostgreSQL did not remain ready after initialization" >&2
  exit 1
}

# Reports whether migrations have already created their ledger. An existing
# volume can carry a valid database without the local init-complete marker when
# an earlier cold-volume seed failed or the marker was removed.
database_initialized() {
  "${compose[@]}" exec -T postgres \
    psql -U postgres -d meltiply -tAc \
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL" 2>/dev/null |
    grep -q '^t$'
}

# Waits for the image entrypoint to finish writing PGDATA (the
# .meltiply-init-complete marker), not just for a listening socket. On failure
# it dumps the service log so the init error survives in CI output.
wait_for_initialization() {
  for _ in $(seq 1 90); do
    if "${compose[@]}" exec -T postgres sh -c \
      'test -f "$PGDATA/.meltiply-init-complete"' >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  # A volume created before the marker existed (or whose entrypoint seed failed)
  # is still usable. Finish the idempotent migration and seed steps once, then
  # record the marker so later starts are fast.
  if database_initialized; then
    "${compose[@]}" exec -T postgres /local/migrate.sh
    "${compose[@]}" exec -T postgres /local/seed.sh
    "${compose[@]}" exec -T postgres sh -c 'touch "$PGDATA/.meltiply-init-complete"'
    return
  fi
  echo "Cloudflare-target PostgreSQL initialization did not complete" >&2
  "${compose[@]}" logs postgres >&2
  exit 1
}

# Starts only PostgreSQL, waits through cold-volume initialization, then applies
# migrations. Repeated calls preserve data and never start optional telemetry.
start() {
  "${compose[@]}" up -d postgres
  wait_for_postgres
  wait_for_initialization
  # On a cold volume, the image stops its temporary initialization server
  # immediately after writing the marker. Require steady readiness across that
  # handoff before invoking psql from the running container.
  wait_for_stable_postgres
  "${compose[@]}" exec -T postgres /local/migrate.sh
}

case "${1:-start}" in
  start)
    start
    ;;
  migrate)
    start
    ;;
  seed)
    start
    "${compose[@]}" exec -T postgres /local/seed.sh
    ;;
  reset)
    "${compose[@]}" down --volumes postgres
    start
    "${compose[@]}" exec -T postgres /local/seed.sh
    ;;
  stop)
    "${compose[@]}" down --volumes postgres
    ;;
  *)
    echo "usage: $0 {start|migrate|seed|reset|stop}" >&2
    exit 2
    ;;
esac
