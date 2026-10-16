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
