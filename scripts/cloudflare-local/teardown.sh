#!/usr/bin/env bash
# Unconditional teardown for shared/self-hosted runners.
# Stops Compose (postgres + Grafana/Tempo/Loki/Prometheus), removes this
# project's volumes/orphans, and best-effort kills Wrangler/workerd started
# for this repo. Everything is scoped to COMPOSE_PROJECT_NAME (the compose
# file's `name:` otherwise): sibling devcontainer projects and daemon-global
# resources are never touched.
#
# FD budget: never wrap each docker call in `sg docker`; repeated shells can
# exhaust file descriptors. Prefer plain `docker`. If the
# process lacks the docker group, re-exec this script once under `sg docker`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/compose.dev.yml"
# The devcontainer injects a per-container COMPOSE_PROJECT_NAME so concurrent
# stacks stay disjoint; host-native runs keep the baseline project. The label
# filters below key on this same name, which is what keeps cleanup scoped.
project_name="${COMPOSE_PROJECT_NAME:-meltiply-cloudflare}"


# Dev ports the Quick Tunnels publish. These mirror the .env defaults so the
# leak net below reaps a connector even when teardown runs without the root
# .env; override them when a stack was started on other ports.
frontend_port="${MELTIPLY_FRONTEND_PORT:-${FRONTEND_DEV_PORT:-3000}}"
api_port="${WRANGLER_DEV_PORT:-8787}"
public_port="${PUBLIC_SITE_DEV_PORT:-4321}"

log() {
  printf 'teardown: %s\n' "$*"
}

# Fail closed before any cleanup: inside a devcontainer the injected
# COMPOSE_PROJECT_NAME is the only thing keeping this teardown away from the
# shared baseline project and from sibling stacks, so a missing value means
# the environment contract is broken and nothing may be removed.
if [[ "${MELTIPLY_DEVCONTAINER:-0}" == "1" && -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
  log "ERROR: MELTIPLY_DEVCONTAINER=1 requires COMPOSE_PROJECT_NAME; aborting cleanup"
  exit 1
fi
# Disarm the cancellation trap before cleanup; otherwise a TERM during this
# script can recursively launch another teardown process. Keep the lock during
# pre-clean so the next job cannot start while this cleanup is still running.
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

# One-shot elevation when the runner process lacks supplemental docker group.
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
  # Primary path — compose.sh supplies the baseline file (and the devcontainer
  # overlay when MELTIPLY_DEVCONTAINER is set); -p pins the same project the
  # label filters below assume, so `down` can never drift to another stack.
  if ! command "$repo_root/scripts/cloudflare-local/compose.sh" \
    -p "$project_name" down --volumes --remove-orphans --timeout 30; then
    log "WARNING: compose -p down failed"
  fi

  # One leftover query per resource kind + optional one rm. No inspect loops.
  # The compose project label is the only ownership proof the daemon keeps;
  # name= filters are substring matches that cannot distinguish sibling
  # projects (meltiply-a matches meltiply-ab-…), so nothing else is consulted.
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

# Best-effort kill of Wrangler/workerd for this checkout only.
# Never pkill -f a pattern that can match this script's own argv.
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

# Shared-runner leak cross-match: each CI job checks out a *different* sibling
# workspace (e.g. ~/project/ci-workspaces/frontend vs
# .../ci-workspaces/cloudflare-database-integration), so a leaked wrangler from
# another job's checkout has a command line rooted at that sibling, not this
# job's repo_root. Anchor the kill patterns at the common workspaces parent so
# any job's teardown also reaps leaks from sibling checkouts. Outside CI (no
# `-workspaces` in the path) this degrades to the plain repo_root.
#
# /path/to/ci-workspaces/<job>   -> anchor /path/to/ci-workspaces
# /path/to/repo                  -> anchor /path/to/repo
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
  # `make dev` runs each Quick Tunnel in its own session and reaps it on exit,
  # but a SIGKILLed launcher orphans the connector. It carries no repository
  # path in argv, so match on the loopback dev ports this stack publishes
  # instead; that keeps another project's tunnel untouched.
  kill_repo_processes "cloudflared .*--url http://127\.0\.0\.1:(${frontend_port}|${api_port}|${public_port})([^0-9]|$)"
fi


# A job killed hard (SIGKILL/runner restart) can leave a wedged listener on a
# fixed stack port whose argv no longer matches the patterns above (renamed or
# exe-swapped process). Nothing else on a shared runner may legally own these
# ports while we hold the stack lock, so kill by port as a final net.
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
