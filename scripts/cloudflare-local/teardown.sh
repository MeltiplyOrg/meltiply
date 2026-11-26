#!/usr/bin/env bash
# Repeated `sg docker` shells can exhaust file descriptors.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/compose.dev.yml"
project_name="${COMPOSE_PROJECT_NAME:-meltiply-cloudflare}"

frontend_port="${MELTIPLY_FRONTEND_PORT:-${FRONTEND_DEV_PORT:-3000}}"
api_port="${WRANGLER_DEV_PORT:-8787}"
public_port="${PUBLIC_SITE_DEV_PORT:-4321}"

log() {
  printf 'teardown: %s\n' "$*"
}

if [[ "${MELTIPLY_DEVCONTAINER:-0}" == "1" && -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
  log "ERROR: MELTIPLY_DEVCONTAINER=1 requires COMPOSE_PROJECT_NAME; aborting cleanup"
  exit 1
fi
if [[ "${MELTIPLY_CI_KEEP_LOCK:-0}" != "1" ]]; then
  if [[ -n "${MELTIPLY_CI_CLEANUP_MARKER:-}" ]]; then
    rm -f -- "$MELTIPLY_CI_CLEANUP_MARKER" 2>/dev/null || true
  fi
  release_ci_lock() {
    if [[ -n "${MELTIPLY_CI_LOCK_RELEASE:-}" ]]; then
      touch -- "$MELTIPLY_CI_LOCK_RELEASE" 2>/dev/null || true
    fi
    if [[ -n "${MELTIPLY_CI_LOCK_HOLDER:-}" && -f "$MELTIPLY_CI_LOCK_HOLDER" ]]; then
      local holder_pid
      holder_pid="$(cat "$MELTIPLY_CI_LOCK_HOLDER" 2>/dev/null || true)"
      [[ -n "$holder_pid" ]] && kill "$holder_pid" 2>/dev/null || true
      rm -f -- "$MELTIPLY_CI_LOCK_HOLDER" "$MELTIPLY_CI_LOCK_RELEASE" 2>/dev/null || true
    fi
  }
  trap release_ci_lock EXIT
fi

if [[ "${MELTIPLY_TEARDOWN_DOCKER_READY:-0}" != "1" ]]; then
  if command docker info >/dev/null 2>&1; then
    export MELTIPLY_TEARDOWN_DOCKER_READY=1
  elif command -v sg >/dev/null 2>&1 && sg docker -c "docker info" >/dev/null 2>&1; then
    log "re-exec under sg docker (one shot)"
    export MELTIPLY_TEARDOWN_DOCKER_READY=1
    exec sg docker -c "MELTIPLY_TEARDOWN_DOCKER_READY=1 $(printf '%q' "$0") $(printf '%q ' "$@")"
  else
    log "WARNING: docker not accessible; Compose cleanup skipped"
  fi
fi

if [[ "${MELTIPLY_TEARDOWN_DOCKER_READY:-0}" == "1" && -f "$compose_file" ]]; then
  log "docker compose down (project=$project_name)"
  if ! command "$repo_root/scripts/cloudflare-local/compose.sh" \
    -p "$project_name" down --volumes --remove-orphans --timeout 30; then
    log "WARNING: compose -p down failed"
  fi

  # Docker name= filters are substring matches; the compose project label is the only
  # ownership proof.
  leftovers="$(
    command docker ps -aq \
      --filter "label=com.docker.compose.project=${project_name}" || true
  )"
  if [[ -n "$leftovers" ]]; then
    # shellcheck disable=SC2086
    log "force-removing leftover containers"
    command docker rm -f $leftovers >/dev/null || true
  fi

  volumes="$(
    command docker volume ls -q \
      --filter "label=com.docker.compose.project=${project_name}" || true
  )"
  if [[ -n "$volumes" ]]; then
    # shellcheck disable=SC2086
    log "force-removing leftover volumes"
    command docker volume rm -f $volumes >/dev/null || true
  fi
elif [[ ! -f "$compose_file" ]]; then
  log "compose file missing at $compose_file"
fi

# pkill -f must not match this script's own argv.
kill_repo_processes() {
  local pattern=$1
  local self_pid=$BASHPID
  local parent_pid=$$
  local pid cmd
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if [[ "$pid" == "$self_pid" || "$pid" == "$parent_pid" ]]; then
      continue
    fi
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ "$cmd" == *"/teardown.sh"* ]]; then
      continue
    fi
    log "killing pid $pid"
    kill -- "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
  done < <(pgrep -f "$pattern" 2>/dev/null || true)
}

if [[ "$repo_root" == */ci-workspaces/* ]]; then
  kill_anchor="$(dirname "$repo_root")"
else
  kill_anchor="$repo_root"
fi

if command -v pgrep >/dev/null 2>&1; then
  kill_repo_processes "$kill_anchor/.*wrangler"
  kill_repo_processes "$kill_anchor/.*workerd"
  kill_repo_processes "$kill_anchor/.*/dev-backend.sh"
  kill_repo_processes "$kill_anchor/.*/dev-api.sh"
  kill_repo_processes "/tmp/meltiply-k6-backend"
  kill_repo_processes "cloudflared .*--url http://127\.0\.0\.1:(${frontend_port}|${api_port}|${public_port})([^0-9]|$)"
fi

if command -v ss >/dev/null 2>&1; then
  for port in 8787 5433 3001 4318 3100 9090 9091; do
    while read -r pid; do
      [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]] || continue
      if [[ "$pid" == "$BASHPID" || "$pid" == "$$" ]]; then
        continue
      fi
      log "killing port $port pid $pid"
      kill -KILL -- "$pid" >/dev/null 2>&1 || true
    done < <(ss -ltnp 2>/dev/null | awk -v port=":$port " '
      index($0, port) {
        if (match($0, /pid=[0-9]+/)) print substr($0, RSTART+4, RLENGTH-4)
      }' | sort -u)
  done
fi

log "done"
