#!/usr/bin/env bash
# Diagnose the local Cloudflare-target development environment.
#
# Layers:
#   1. Toolchain   pinned Node, Bun, Wrangler, OpenTofu, Docker, Compose
#   2. Repository  workspace deps, root .env keys, compose service set
#   3. Live stack  PostgreSQL container + query, API Worker health/readiness,
#                  frontend dev server, and the browser-baked API origin
#   4. Diagnostics process forensics for the exact "frontend up, backend dead"
#                  state: crashed wrangler sessions, orphaned runtimes
#
# Exit codes: 0 healthy, 1 failed prerequisite/error, 2 degraded (live stack).
# `make doctor` runs this script; CI only relies on the exit code.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

errors=0
degraded=0

# --- output helpers -----------------------------------------------------------

ok() { printf '[ok] %s\n' "$1"; }
note() { printf '[note] %s\n' "$1"; }
fail() {
  printf '[error] %s\n' "$1" >&2
  errors=$((errors + 1))
}
warn() {
  printf '[warn] %s\n' "$1"
  degraded=$((degraded + 1))
}
hint() { printf '       %s\n' "$1" >&2; }

record() {
  # record <pass|warn> <label> <command...>
  # pass: prints [ok], failure counts as an error; warn: failure counts as degraded.
  local severity=$1 label=$2
  shift 2
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    case "$severity" in
      warn) warn "$label" ;;
      *) fail "$label" ;;
    esac
  fi
}

section() { printf '\n== %s ==\n' "$1"; }

# --- shared env ---------------------------------------------------------------

# shellcheck source=wrangler-env.sh
source "$repo_root/scripts/cloudflare-local/wrangler-env.sh"
load_local_env "$repo_root/.env"

# The media processor runs in a linux/amd64 Cloudflare Container; `wrangler dev`
# builds and starts that image with the local Docker daemon, so a host without
# amd64 execution can boot the stack but never process media.
# shellcheck source=container-runtime.sh
source "$repo_root/scripts/cloudflare-local/container-runtime.sh"

api_port="${WRANGLER_DEV_PORT:-8787}"
frontend_port="${MELTIPLY_FRONTEND_PORT:-${FRONTEND_DEV_PORT:-3000}}"
postgres_port="${MELTIPLY_CLOUDFLARE_POSTGRES_PORT:-5433}"
# The shared Compose boundary resolves the baseline file plus the devcontainer
# overlay under MELTIPLY_DEVCONTAINER, so ps/exec observe the same project any
# other caller manages.
compose=("$repo_root/scripts/cloudflare-local/compose.sh")
dev_host="$(node "$repo_root/scripts/cloudflare-local/development-host.mjs")"
api_origin="${PUBLIC_API_URL:-http://${dev_host}:${api_port}}"
frontend_origin="${FRONTEND_URL:-http://${dev_host}:${frontend_port}}"

http_code() {
  # http_code <url> [extra curl args...] -> prints status code or 000
  local url=$1
  shift
  curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' \
    "$@" "$url" 2>/dev/null || printf '000'
}

port_listener_pids() {
  # pids of processes listening on TCP $1, empty when none
  ss -ltnpH 2>/dev/null | awk -v port=":$1 " 'index($0, port)' |
    grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

# --- layer 1: toolchain -------------------------------------------------------

section 'Toolchain'

check_node_version() {
  [[ "$(node --version)" == "v24.18.0" ]]
}
# Require the same Bun release as CI so lockfile and override semantics agree.
check_bun_version() {
  [[ "$(bun --version)" == "1.4.2" ]]
}
# Check the installed Node CLI against the shared CI/release pin, without downloading.
check_wrangler_version() {
  [[ "$(bun run --no-install wrangler --version | tail -n 1 | tr -d '[:space:]')" == '4.148.0' ]]
}
check_opentofu_version() {
  .bin/tofu version -json |
    grep -Eq '"terraform_version"[[:space:]]*:[[:space:]]*"1\.12\.0"'
}

# record prints [ok] or the failure itself and counts it; no fallback needed.
record fail "Node v24.18.0" check_node_version
record fail "Bun 1.4.2" check_bun_version
record fail "Wrangler 4.148.0" check_wrangler_version
record fail "OpenTofu 1.12.0" check_opentofu_version
record fail "Docker daemon reachable" docker info
record fail "Docker Compose available" docker compose version

# The processor container needs amd64 execution. Missing emulation is a note and
# not a degraded exit code: nothing else in the stack depends on it, and the CI
# gate must not hinge on a host kernel capability. The hint names the actual
# remedy instead of leaving a silent processing failure later.
if container_emulation_ready; then
  ok "local container runtime can execute $(container_image_platform)"
else
  note "no $(container_image_platform) execution on this $(uname -m) host; the media processor cannot run locally"
  hint "$(container_emulation_hint)"
fi

# The processor smoke's strict mode bounds every container with Docker's
# CPU/memory flags, which runc applies only inside a cgroup v2 domain. A
# threaded daemon cgroup is a note for the same reason as missing emulation:
# the stack still runs and the CI gate must not hinge on a host kernel
# capability, but the envelope stays unverified until the hierarchy is
# repaired, so the note says exactly which cgroup blocks it.
if container_cgroup_limits_ready; then
  ok "local container runtime can enforce processor CPU/memory limits"
else
  note "$(container_daemon_cgroup)/cgroup.type is threaded; the processor smoke cannot enforce its CPU/memory envelope"
  hint "$(container_cgroup_hint)"
fi

# cloudflared is what publishes the dev stack, so its absence is a note rather
# than a prerequisite failure: `make dev` still serves local/Tailscale origins.
if command -v cloudflared >/dev/null 2>&1; then
  if "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" named-possible; then
    ok "cloudflared available; a named tunnel on your domain is also possible"
    note "\`make dev\` uses a Quick Tunnel that Cloudflare deletes automatically"
    hint "MELTIPLY_DEV_TUNNEL_MODE=named gives a stable hostname but needs manual cleanup"
  else
    ok "cloudflared available for \`make dev\` quick tunnels"
    note "\`make dev\` will publish a Quick Tunnel that Cloudflare deletes automatically"
    hint "run \`cloudflared tunnel login\` only if you want a stable named hostname"
  fi
else
  note "cloudflared not installed; \`make dev\` will serve local origins only"
  hint "run scripts/cloudflare-local/dev-tunnel.sh binary for install options, or set MELTIPLY_DEV_TUNNEL=0"
fi

if command -v curl >/dev/null 2>&1 && command -v ss >/dev/null 2>&1; then
  ok "curl and ss available for live probes"
else
  warn "curl or ss missing; live-stack probes will be inconclusive"
fi

# --- layer 2: repository ------------------------------------------------------

section 'Repository'

[[ -d node_modules ]] &&
  ok "workspace dependencies installed" ||
  fail "node_modules missing; run \`make setup\` or \`bun install\`"

# The root .env must carry the local auth, mail sender, and encryption keys.
# Local mail runs through Wrangler's simulated send_email binding, so only the
# neutral MAIL_FROM_ADDRESS sender identity is required — no delivery secret.
# MAIL_FROM_NAME is optional and not checked here.
check_root_local_vars() {
  local file=$1
  test -f "$file" || return 1
  grep -q '^BETTER_AUTH_SECRET=' "$file" || return 1
  grep -q '^BETTER_AUTH_URL=' "$file" || return 1
  grep -q '^MAIL_FROM_ADDRESS=' "$file" || return 1
  grep -q '^TOKEN_ENCRYPTION_KEY=' "$file"
}
record fail "root .env has Better Auth/mail/encryption configuration" check_root_local_vars "$repo_root/.env"

# Checks that the merged Compose file set (baseline, plus the devcontainer
# overlay when active) still selects only PostgreSQL by default while the
# opt-in profile exposes all telemetry services; runs the shared boundary so
# the answer matches what lifecycle callers use, and needs nothing running.
check_compose_services() {
  local services expected i
  mapfile -t services < <(
    "${compose[@]}" config --services 2>/dev/null | sort
  )
  [[ ${#services[@]} -eq 1 && "${services[0]}" == postgres ]] || return 1
  mapfile -t services < <(
    "${compose[@]}" --profile observability config --services 2>/dev/null | sort
  )
  expected=(grafana loki postgres prometheus pushgateway tempo)
  [[ ${#services[@]} -eq ${#expected[@]} ]] || return 1
  for i in "${!expected[@]}"; do
    [[ "${services[$i]}" == "${expected[$i]}" ]] || return 1
  done
}
record fail "compose defaults to postgres with optional observability profile" check_compose_services

# --- layer 3: live stack ------------------------------------------------------

section 'Live stack'

# PostgreSQL container + queryability
pg_running=0
if "${compose[@]}" ps --status running postgres 2>/dev/null | grep -q postgres; then
  pg_running=1
  if "${compose[@]}" exec -T postgres psql -U meltiply_rls -d meltiply -c 'SELECT 1' >/dev/null 2>&1; then
    ok "PostgreSQL target accepting queries on :${postgres_port}"
  else
    warn "PostgreSQL container running but not accepting queries"
    hint "run \`bun run db:start\` to (re)migrate and verify"
  fi
else
  note "PostgreSQL container stopped; run \`bun run db:start\`"
fi

# API Worker health/readiness on the configured port(s)
probe_api() {
  local base=$1
  local health readiness
  health=$(http_code "${base}/api/v1/health")
  if [[ "$health" != '200' ]]; then
    return 1
  fi
  ok "API Worker healthy at ${base}/api/v1/health"
  readiness=$(http_code "${base}/api/v1/ready")
  if [[ "$readiness" == '200' ]]; then
    ok "API Worker ready at ${base}/api/v1/ready (database reachable)"
  else
    warn "API Worker answers but readiness reports ${readiness} at ${base}/api/v1/ready"
    hint "the Worker is up but its dependencies are not; check PostgreSQL above"
  fi
  return 0
}

api_ok=0
for api_base in "http://127.0.0.1:${api_port}" "$api_origin"; do
  if probe_api "$api_base"; then
    api_ok=1
    break
  fi
done

if ((api_ok == 0)); then
  warn "API Worker not responding on :${api_port} (${api_origin})"
fi

# Frontend dev server
frontend_status=$(http_code "http://127.0.0.1:${frontend_port}/")
if [[ "$frontend_status" == '200' ]]; then
  ok "Frontend dev server serving on :${frontend_port}"

  # Browser-baked API origin must be one doctor can also reach.
  baked_base_url="$(
    curl --silent --max-time 5 "http://127.0.0.1:${frontend_port}/src/main.tsx" 2>/dev/null |
      grep -o '"API_BASE_URL"[^,}]*' | head -1 |
      sed 's/.*: *"\(.*\)"/\1/'
  )"
  if [[ -z "$baked_base_url" ]]; then
    warn "could not read API_BASE_URL from the Vite module graph"
    hint "is the dev entry still at /src/main.tsx? check frontend/index.html"
  elif [[ "$baked_base_url" != "$api_origin" ]]; then
    warn "browser bakes API_BASE_URL=${baked_base_url}, doctor derived ${api_origin}"
    hint "restart \`make dev\` after changing FRONTEND_URL/PUBLIC_API_URL/.env so Vite re-injects it"
  else
    ok "Browser-baked API origin matches the derived origin (${api_origin})"
  fi
elif [[ "$frontend_status" != '000' ]]; then
  warn "Frontend dev server answered HTTP ${frontend_status} on :${frontend_port}"
else
  note "Frontend dev server not running on :${frontend_port}; run \`make dev\` or \`make frontend-boot\`"
fi

# Cross-check: frontend alive but API dead is today's recurring failure mode.
if [[ "$frontend_status" == '200' && "$api_ok" == '0' ]]; then
  warn "frontend is serving but no API Worker is reachable: views will show"
  warn "'Meltiply could not refresh this view / could not reach the API'"
  hint "start it with \`bun run dev:backend\` (backend only) or restart \`make dev\`"
fi

# --- layer 4: diagnostics -----------------------------------------------------

section 'Diagnostics'

# Crashed wrangler sessions leave a log whose last entry says why. Read-only:
# never delete user logs, only point at them.
latest_wrangler_log="$(ls -t "${HOME}/.config/.wrangler/logs/"wrangler-*.log 2>/dev/null | head -1 || true)"
if [[ -n "$latest_wrangler_log" ]] && tail -c 65536 "$latest_wrangler_log" | grep -q 'Network connection lost'; then
  log_stamp="$(basename "$latest_wrangler_log" | sed -E 's/wrangler-([0-9-]+_[0-9-]+)_.*/\1/')"
  warn "most recent wrangler session (${log_stamp}) ended with 'Network connection lost'"
  hint "the API Worker crashed instead of exiting cleanly; see ${latest_wrangler_log}"
  hint "restart with \`bun run dev:backend\` or \`make dev\`"
fi

# Orphaned workerd: a runtime whose ancestor chain contains neither wrangler
# nor a vite dev server for this checkout. These hold ports/DO state silently.
orphan_runtime=''
if pgrep -f "$repo_root/.*workerd" >/dev/null 2>&1; then
  while IFS= read -r pid; do
    ancestor_is_supervisor=0
    walk_pid="$pid"
    for _ in 1 2 3 4 5 6; do
      walk_pid="$(ps -o ppid= -p "$walk_pid" 2>/dev/null | tr -d ' ')" || break
      [[ -n "$walk_pid" && "$walk_pid" != '1' ]] || break
      walk_cmd="$(ps -o args= -p "$walk_pid" 2>/dev/null || true)"
      if [[ "$walk_cmd" == *wrangler* || "$walk_cmd" == *vite* ]]; then
        ancestor_is_supervisor=1
        break
      fi
    done
    if ((ancestor_is_supervisor == 0)); then
      orphan_runtime="${orphan_runtime}${pid} "
    fi
  done < <(pgrep -f "$repo_root/.*workerd" 2>/dev/null)
fi
if [[ -n "$orphan_runtime" ]]; then
  warn "orphaned workerd runtime(s) without a live wrangler/vite parent: $(printf '%s' "$orphan_runtime" | sed 's/ *$//')"
  hint "free them with \`bun run local:teardown\`"
else
  ok "no orphaned workerd runtimes for this checkout"
fi

# Port ownership sanity: :8787 held by something that is not a healthy API.
if ((api_ok == 0)); then
  port_pids="$(port_listener_pids "$api_port")"
  if [[ -n "$port_pids" ]]; then
    warn "port ${api_port} is held by pid(s) ${port_pids// /, } but the API is unhealthy"
    hint "inspect with: ps -fp ${port_pids// /,}"
  fi
fi

# Stale wrangler state can pin old ports/secrets after crashes.
if [[ -d "$repo_root/.wrangler/state" ]]; then
  ok "local wrangler state present (.wrangler/state)"
else
  note "no local wrangler state yet; first \`bun run dev:backend\` will create it"
fi

# --- summary ------------------------------------------------------------------

section 'Summary'
if ((errors > 0)); then
  printf 'doctor found %d error(s), %d warning(s).\n' "$errors" "$degraded" >&2
  exit 1
fi
if ((degraded > 0)); then
  printf 'prerequisites are fine, but %d live-stack problem(s) need attention.\n' "$degraded" >&2
  exit 2
fi
printf 'Cloudflare-target environment is fully healthy.\n'
