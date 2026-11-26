#!/usr/bin/env bash
set -euo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=("$compose_dir/compose.sh")

postgres_ready() {
  "${compose[@]}" exec -T postgres pg_isready -U postgres -d meltiply >/dev/null 2>&1
}
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
# A cold volume reports ready while the image's temporary init server runs, then
# restarts.
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

database_initialized() {
  "${compose[@]}" exec -T postgres \
    psql -U postgres -d meltiply -tAc \
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL" 2>/dev/null |
    grep -q '^t$'
}

wait_for_initialization() {
  for _ in $(seq 1 90); do
    if "${compose[@]}" exec -T postgres sh -c \
      'test -f "$PGDATA/.meltiply-init-complete"' >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
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

start() {
  "${compose[@]}" up -d postgres
  wait_for_postgres
  wait_for_initialization
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
