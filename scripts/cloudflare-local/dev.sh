#!/usr/bin/env bash
# Starts the local Worker, app, and unified public-site development services in
# isolated process groups. A service failure or Ctrl-C stops every group that
# this invocation owns, preventing a live frontend from waiting on a dead
# backend.
#
# An optional Cloudflare Quick Tunnel makes the stack reachable from any network.
# When enabled, the tunnel origin becomes the canonical frontend origin for the
# whole run. That is only coherent because the
# app Worker already proxies `/api/*` to the API Worker (service binding when
# deployed, API_ORIGIN locally), so a single public hostname serves the SPA and
# the API on one origin: no CORS, and the Better Auth session cookie stays a
# first-party cookie. Set MELTIPLY_DEV_TUNNEL=1 to opt into public origins.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bun="${BUN:-bun}"
# Services whose exit ends the run.
service_pids=()
# Helpers that must be reaped on exit but must not end the run when they finish
# (the tunnel readiness probe completes successfully by design).
cleanup_pids=()
cleanup_started=0
tunnel_log_dir="$repo_root/.wrangler/logs"
tunnel_mode="none"
declare -A tunnel_urls=()
stack_lock="$repo_root/.wrangler/dev.lock"
stack_owner="$repo_root/.wrangler/dev.pid"
owns_stack=0

# Serializes launches for this checkout and replaces its previous supervisor.
# The lock descriptor validates the recorded PID before signaling it, avoiding
# stale-PID kills. Waits up to 15 seconds for its service groups to shut down;
# unrelated port listeners are never killed, and failed shutdown aborts startup.
claim_stack() {
  mkdir -p "$repo_root/.wrangler"
  exec 8>"$repo_root/.wrangler/dev-start.lock"
  flock -x 8
  exec 9>"$stack_lock"
  if ! flock -n 9; then
    local owner=""
    [[ ! -f "$stack_owner" ]] || read -r owner <"$stack_owner" || true
    if [[ "$owner" =~ ^[0-9]+$ ]] &&
      [[ "$(stat -Lc '%d:%i' "/proc/$owner/fd/9" 2>/dev/null || true)" == \
        "$(stat -Lc '%d:%i' "$stack_lock")" ]]; then
      printf 'Stopping existing development stack (PID %s)...\n' "$owner"
      kill -TERM "$owner" 2>/dev/null || true
    fi
    if ! flock -w 15 9; then
      printf 'Previous development stack did not stop; refusing to start overlapping services.\n' >&2
      return 1
    fi
  fi
  printf '%s\n' "$$" >"$stack_owner"
  owns_stack=1
  exec 8>&-
}

# Loads local defaults and derives the public origins shared by every dev
# service. Existing environment values win so callers can run isolated stacks
# with alternate ports or container tunnel transport; exports the resulting
# values to all children, preserving explicit tunnel settings over root .env.
load_stack_environment() {
  # Preserve explicit caller settings over checkout-local .env defaults.
  local -a caller_overrides=()
  local name
  for name in MELTIPLY_DEV_HOST MELTIPLY_DEV_TUNNEL MELTIPLY_DEV_TUNNEL_MODE \
    MELTIPLY_CLOUDFLARED_BIN CLOUDFLARED_BIN TUNNEL_TRANSPORT_PROTOCOL \
    MELTIPLY_TUNNEL_NAME MELTIPLY_TUNNEL_NAME_PREFIX MELTIPLY_TUNNEL_SHARED \
    MELTIPLY_TUNNEL_DOMAIN MELTIPLY_TUNNEL_DEV_LABEL \
    MELTIPLY_TUNNEL_HOST_STYLE MELTIPLY_TUNNEL_BRANCH; do
    [[ -n "${!name:-}" ]] && caller_overrides+=("$name=${!name}")
  done

  set -a
  [[ ! -f "$repo_root/.env" ]] || source "$repo_root/.env"
  set +a

  for name in "${caller_overrides[@]}"; do
    export "$name"
  done

  local api_port="${WRANGLER_DEV_PORT:-8787}"
  local frontend_port="${MELTIPLY_FRONTEND_PORT:-${FRONTEND_DEV_PORT:-3000}}"
  local public_port="${PUBLIC_SITE_DEV_PORT:-4321}"
  local dev_host
  dev_host="$(node "$repo_root/scripts/cloudflare-local/development-host.mjs")"
  local bind_host="127.0.0.1"
  [[ "$dev_host" == "127.0.0.1" || "$dev_host" == "localhost" ]] || bind_host="0.0.0.0"

  export WRANGLER_DEV_IP="${WRANGLER_DEV_IP:-$bind_host}"
  export FRONTEND_DEV_HOST="${FRONTEND_DEV_HOST:-$bind_host}"
  export WRANGLER_DEV_PORT="$api_port"
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${FRONTEND_URL:-http://$dev_host:$frontend_port}}"
  export FRONTEND_URL="${FRONTEND_URL:-http://$dev_host:$frontend_port}"
  export PUBLIC_SITE_URL="${PUBLIC_SITE_URL:-http://$dev_host:$public_port}"
  export PUBLIC_API_URL="${PUBLIC_API_URL:-http://$dev_host:$api_port}"
  export API_BASE_URL="${API_BASE_URL:-$PUBLIC_API_URL}"
  export WRANGLER_DEV_ALLOWED_ORIGINS="$ALLOWED_ORIGINS"
  export WRANGLER_DEV_FRONTEND_URL="$FRONTEND_URL"
  export WRANGLER_DEV_PUBLIC_API_URL="$PUBLIC_API_URL"

  api_dev_port="$api_port"
  frontend_dev_port="$frontend_port"
  public_dev_port="$public_port"
  local_frontend_origin="$FRONTEND_URL"
  local_api_origin="$PUBLIC_API_URL"
  local_public_origin="$PUBLIC_SITE_URL"
  # Read after the .env source so the summary agrees with the hostnames
  # tunnel-hostname.mjs derives, which read the environment at call time.
  DEV_TUNNEL_DOMAIN="${MELTIPLY_TUNNEL_DOMAIN:-}"
}

# Starts one Quick Tunnel in its own session and waits for the hostname
# cloudflared assigns it. The URL is stored rather than echoed so command
# substitution cannot swallow the launcher's own progress output.
#
# @param $1 Service label used in the log filename and tunnel_urls key.
# @param $2 Loopback port to publish.
# @return 0 with tunnel_urls[$1] set; non-zero when no URL is published.
launch_quick_tunnel() {
  local service=$1 port=$2 log="$tunnel_log_dir/quick-tunnel-$1.log"
  mkdir -p "$tunnel_log_dir"
  : >"$log"

  # setsid makes the connector its own group leader, so the shared cleanup
  # reaps the tunnel with the same signal path used for wrangler and Vite.
  setsid "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" run "$port" \
    >"$log" 2>&1 &
  local pid=$!
  service_pids+=("$pid")

  if ! tunnel_urls[$service]="$(node \
    "$repo_root/scripts/cloudflare-local/quick-tunnel-url.mjs" \
    --log "$log" --pid "$pid" --timeout 90)"; then
    return 1
  fi
}

# Starts the named tunnel, publishing the app and unified public site
# from a single connector.
#
# No URL discovery happens here: the hostnames are configured, so they are known
# before the connector starts and the origins can be applied immediately. That
# removes the log-polling and its timeout, and makes the URL stable across runs.
#
# @return 0 with tunnel_urls[app] and tunnel_urls[public] set.
launch_named_tunnel() {
  local config log="$tunnel_log_dir/named-tunnel.log" name
  # Provision this branch's tunnel and its DNS records on demand, so a new
  # branch needs no manual step. Idempotent: an existing tunnel or record is
  # the desired end state.
  "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" setup || return 1
  name="$(node "$repo_root/scripts/cloudflare-local/tunnel-hostname.mjs" \
    --tunnel-name)"

  config="$("$repo_root/scripts/cloudflare-local/tunnel-config.sh" \
    write "$frontend_dev_port" "$public_dev_port")" || return 1

  # Validate the ingress rules with cloudflared before relying on them, so a
  # typo fails here rather than as a connector that routes nothing.
  if ! "$repo_root/scripts/cloudflare-local/tunnel-config.sh" validate; then
    printf 'Generated tunnel configuration is invalid: %s\n' "$config" >&2
    return 1
  fi

  mkdir -p "$tunnel_log_dir"
  : >"$log"
  setsid "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" run-named \
    "$config" "$name" >"$log" 2>&1 &
  service_pids+=("$!")

  tunnel_urls[app]="https://$(node \
    "$repo_root/scripts/cloudflare-local/tunnel-hostname.mjs" --kind app)"
  tunnel_urls[public]="https://$(node \
    "$repo_root/scripts/cloudflare-local/tunnel-hostname.mjs" --kind public)"
}

# Re-derives every shared origin from the published tunnel hostnames.
#
# The local frontend origin stays in ALLOWED_ORIGINS alongside the public one so
# a browser that has not yet been redirected — and direct API calls from the
# loopback ports — remain authorized. The Worker reads these through the
# WRANGLER_DEV_* channel because dev-backend.sh re-sources the root .env, which
# would otherwise overwrite the tunnel values with that file's empty defaults.
apply_tunnel_origins() {
  local app_url=${tunnel_urls[app]}
  local public_url=${tunnel_urls[public]}

  export FRONTEND_URL="$app_url"
  # Same-origin by design: the app Worker forwards /api/* to the API Worker, so
  # the browser never makes a cross-origin request and the session cookie is
  # first-party over the tunnel's HTTPS.
  export API_BASE_URL="$app_url"
  export PUBLIC_API_URL="$app_url"
  export ALLOWED_ORIGINS="$local_frontend_origin,$app_url"
  export WRANGLER_DEV_ALLOWED_ORIGINS="$ALLOWED_ORIGINS"
  export WRANGLER_DEV_FRONTEND_URL="$app_url"
  export WRANGLER_DEV_PUBLIC_API_URL="$app_url"
  export PUBLIC_SITE_URL="$public_url"
}

# Confirms the public route works end to end once DNS has propagated.
#
# The probe deliberately sends an Origin header: it exercises the API's
# ALLOWED_ORIGINS check, which is the wiring that otherwise only surfaces in a
# browser on the first write. Runs detached so a slow tunnel never delays the
# stack, and reports a single conclusive line either way.
probe_tunnel() {
  local app_url=$1 code=000
  command -v curl >/dev/null 2>&1 || return 0
  for _ in $(seq 1 40); do
    code="$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
      --header "Origin: $app_url" "$app_url/api/v1/health" 2>/dev/null)" || code="000"
    if [[ "$code" == '200' ]]; then
      printf 'Tunnel live: app and API reachable at %s\n' "$app_url"
      return 0
    fi
    sleep 3
  done
  printf 'Tunnel published but %s did not answer /api/v1/health (last HTTP %s).\n' \
    "$app_url" "$code" >&2
  printf '  check the connector log in %s and that Vite allows the tunnel host\n' \
    "$tunnel_log_dir" >&2
}

# Publishes the app and unified public site and promotes the app hostname to
# the canonical origin.
#
# Quick Tunnels are the default, and the only mode that needs no cleanup.
# Cloudflare reaps a Quick Tunnel and its DNS record roughly five minutes after
# the connector disconnects, so a container that is cut off leaves nothing
# behind. A named tunnel is the opposite: it deliberately outlives the process,
# and without a teardown step it would leak one tunnel plus two CNAMEs per
# branch forever, so it is opt-in only.
#
# Returns 1 only when a connector is present and started but cannot publish,
# which must fail the run rather than silently handing back a local-only stack
# the caller believes is public.
start_tunnel() {
  if [[ "${MELTIPLY_DEV_TUNNEL:-0}" == "0" ]]; then
    printf 'Dev tunnel disabled (set MELTIPLY_DEV_TUNNEL=1 to publish public origins).\n'
    tunnel_mode="disabled"
    return 0
  fi

  if [[ "${MELTIPLY_DEV_TUNNEL_MODE:-quick}" == "named" ]]; then
    warn_named_tunnel_leaks
    if "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" named-possible; then
      printf "Using this branch's named Cloudflare Tunnel.\n"
      if launch_named_tunnel; then
        tunnel_mode="named"
        apply_tunnel_origins
        return 0
      fi
      printf 'Named tunnel could not be provisioned or started.\n' >&2
      return 1
    fi
    printf 'Named tunnel requested but the account is not authorized.\n' >&2
    printf '  run `cloudflared tunnel login`, or use the default Quick Tunnel\n' >&2
    return 1
  fi

  if ! "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" binary >/dev/null; then
    printf 'Dev tunnel unavailable; serving local origins only.\n'
    tunnel_mode="none"
    return 0
  fi

  printf 'Publishing Cloudflare Quick Tunnel (random hostname, changes every run)...\n'
  printf '  Cloudflare deletes this tunnel and its DNS record ~5 minutes after exit.\n'
  if ! launch_quick_tunnel app "$frontend_dev_port"; then
    printf 'Could not publish a quick tunnel for the app on port %s.\n' \
      "$frontend_dev_port" >&2
    return 1
  fi
  if ! launch_quick_tunnel public "$public_dev_port"; then
    printf 'Could not publish a quick tunnel for the public site on port %s.\n' \
      "$public_dev_port" >&2
    return 1
  fi
  tunnel_mode="quick"
  apply_tunnel_origins
}

# States the cost of a named tunnel before creating one, because nothing in
# this repository will ever delete it again.
warn_named_tunnel_leaks() {
  cat >&2 <<'LEAK'
MELTIPLY_DEV_TUNNEL_MODE=named opts out of Cloudflare's automatic cleanup.
A named tunnel and its DNS records persist until deleted by hand, so cutting
this container off leaves one tunnel and two CNAMEs behind per branch.
LEAK
}

# Reports the app/API and unified public-site origins, with docs as a path on
# the public site rather than a separate service. Omits unpublished tunnel URLs.
print_stack_summary() {
  if [[ -n "${tunnel_urls[app]+published}" ]]; then
    if [[ "$tunnel_mode" == "named" ]]; then
      printf 'Public stack (Cloudflare Tunnel, %s)\n' "$DEV_TUNNEL_DOMAIN"
    else
      printf 'Public stack (Cloudflare Quick Tunnel)\n'
    fi
    printf '  app + api  %s   (app Worker proxies /api/* to the API Worker)\n' \
      "${tunnel_urls[app]}"
    printf '  public     %s   (landing + docs at /docs/)\n' "${tunnel_urls[public]}"
    printf 'The tunnel hostname is canonical: opening a local port redirects here.\n'
  fi
  printf 'Local stack: app=%s api=%s public=%s (docs at /docs/)\n' \
    "$local_frontend_origin" "$local_api_origin" "$local_public_origin"
}

# Terminates one service session by its leader PID. Each child is launched with
# setsid, so signaling the negative PID reaches Wrangler/workerd or the Vite/
# Astro descendants without touching the caller's terminal process group.
terminate_service_group() {
  local pid=$1
  kill -TERM -- "-$pid" >/dev/null 2>&1 || true
}

# Stops all services launched by this invocation and reaps them before exit.
# It is idempotent because EXIT follows INT/TERM handlers; the original status
# is preserved so a failed backend makes make dev fail rather than hang.
cleanup() {
  local exit_status=$?
  ((cleanup_started)) && return 0
  cleanup_started=1
  trap - EXIT INT TERM

  local pid
  for pid in "${service_pids[@]}" "${cleanup_pids[@]}"; do
    terminate_service_group "$pid"
  done
  for pid in "${service_pids[@]}" "${cleanup_pids[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
  if ((owns_stack)); then
    rm -f "$stack_owner"
  fi

  return "$exit_status"
}

# Converts an interactive interrupt into a conventional shell exit status after
# cleanup. SIGTERM uses 143; Ctrl-C uses 130, while EXIT preserves child errors.
exit_after_signal() {
  local status=$1
  cleanup
  exit "$status"
}

load_stack_environment
# Fail fast when the frontend Worker's /api/* proxy would dial the wrong port.
"$repo_root/scripts/cloudflare-local/frontend-api-origin.sh" "$api_dev_port"
trap cleanup EXIT
trap 'exit_after_signal 130' INT
trap 'exit_after_signal 143' TERM
claim_stack

if ! start_tunnel; then
  printf 'Run `MELTIPLY_DEV_TUNNEL=0 make dev` to start without a public tunnel.\n' >&2
  exit 1
fi
if [[ -n "${tunnel_urls[app]+published}" ]]; then
  (probe_tunnel "${tunnel_urls[app]}") &
  cleanup_pids+=("$!")
fi
print_stack_summary

setsid "$repo_root/scripts/cloudflare-local/dev-backend.sh" &
service_pids+=("$!")
setsid bash -c 'cd "$1"; exec "$2" run --no-install dev --port "$3" --strictPort' _ \
  "$repo_root/frontend/app" "$bun" "$frontend_dev_port" &
service_pids+=("$!")
# ASTRO_DEV_BACKGROUND pins the dev server to the foreground: Astro detects
# agentic shells and otherwise self-daemonizes, whose clean exit would make
# wait -n tear down the whole stack.
setsid bash -c 'cd "$1"; exec env ASTRO_DEV_BACKGROUND=1 "$2" run --no-install dev --host "$3" --port "$4"' _ \
  "$repo_root/frontend/public" "$bun" "$FRONTEND_DEV_HOST" "$public_dev_port" &
service_pids+=("$!")

set +e
wait -n "${service_pids[@]}"
service_status=$?
set -e
if ((service_status == 0)); then
  printf 'A local development service stopped unexpectedly.\n' >&2
  exit 1
fi
exit "$service_status"
