#!/usr/bin/env bash
# Shared local-Wrangler environment handling. Source this after `set -euo pipefail`.

load_local_env() {
  local env_file=$1
  local name assignment
  local -a inherited_wrangler_env=()
  [[ -f "$env_file" ]] || return 0

  # Command-line Worker overrides are more specific than repository defaults.
  while IFS= read -r name; do
    inherited_wrangler_env+=("$name=${!name}")
  done < <(compgen -v WRANGLER_DEV_)

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  for assignment in "${inherited_wrangler_env[@]}"; do
    export "$assignment"
  done
}

# Derive the same host, bind address, and CORS origins as `make dev` when a
# Worker launcher runs on its own. Explicit process or `.env` values take
# precedence. Signing keys default to loopback on the selected API port so
# protected public tunnels do not require a browser Access session in the Worker.
configure_local_wrangler_network() {
  local repo_root=$1
  local frontend_port=$2
  local api_port=$3
  local dev_host
  dev_host="$(node "$repo_root/scripts/cloudflare-local/development-host.mjs")"

  local bind_host="127.0.0.1"
  [[ "$dev_host" == "127.0.0.1" || "$dev_host" == "localhost" ]] || bind_host="0.0.0.0"
  local frontend_origin="${APP_URL:-http://${dev_host}:${frontend_port}}"

  export WRANGLER_DEV_IP="${WRANGLER_DEV_IP:-$bind_host}"
  export WRANGLER_DEV_ALLOWED_ORIGINS="${WRANGLER_DEV_ALLOWED_ORIGINS:-${ALLOWED_ORIGINS:-$frontend_origin}}"
  export WRANGLER_DEV_APP_URL="${WRANGLER_DEV_APP_URL:-$frontend_origin}"
  export WRANGLER_DEV_BETTER_AUTH_JWKS_URL="${WRANGLER_DEV_BETTER_AUTH_JWKS_URL:-${BETTER_AUTH_JWKS_URL:-http://127.0.0.1:${api_port}/api/auth/jwks}}"
}
append_local_wrangler_env_file() {
  local args_name=$1
  local env_file=$2
  local -n wrangler_args_ref="$args_name"

  [[ -f "$env_file" ]] || return 0
  wrangler_args_ref+=(--env-file "$env_file")
}

# Append public origin and trusted key-fetch overrides to the named Wrangler
# argument array. Explicit local overrides win; no credential values are emitted.
append_local_wrangler_overrides() {
  local args_name=$1
  local -n wrangler_args_ref="$args_name"

  # The config's local origins stay authoritative even when the root `.env`
  # keeps browser settings blank. These are non-secret command-line variables.
  local allowed_origins="${WRANGLER_DEV_ALLOWED_ORIGINS:-http://localhost:3000}"
  local frontend_url="${WRANGLER_DEV_APP_URL:-http://localhost:3000}"
  local jwks_url="${WRANGLER_DEV_BETTER_AUTH_JWKS_URL:-http://127.0.0.1:8787/api/auth/jwks}"
  wrangler_args_ref+=(
    --var "ALLOWED_ORIGINS:${allowed_origins}"
    --var "APP_URL:${frontend_url}"
    --var "BETTER_AUTH_JWKS_URL:${jwks_url}"
  )
}

# Appends the Wrangler flag that decides whether `wrangler dev` builds and runs
# the Automation Worker's media processor container. Wrangler defaults this to
# on, so an explicit flag is what makes the local container runtime a deliberate
# choice instead of an accident of the pinned CLI default.
#
# WRANGLER_DEV_ENABLE_CONTAINERS=true  runs the container (needs Docker plus
#                                      amd64 emulation on non-amd64 hosts)
# WRANGLER_DEV_ENABLE_CONTAINERS=false boots the rest of the local stack and
#                                      reports the processing failure truthfully
# Unset keeps Wrangler's default; unrecognised values fail before launch.
#
# @param $1 Name of the Bash array holding the Wrangler arguments.
append_local_wrangler_container_flags() {
  local args_name=$1
  local -n wrangler_args_ref="$args_name"

  case "${WRANGLER_DEV_ENABLE_CONTAINERS:-}" in
    true | false)
      wrangler_args_ref+=("--enable-containers=${WRANGLER_DEV_ENABLE_CONTAINERS}")
      ;;
    '')
      ;;
    *)
      printf \
        'WRANGLER_DEV_ENABLE_CONTAINERS must be true or false, got: %s\n' \
        "$WRANGLER_DEV_ENABLE_CONTAINERS" >&2
      return 1
      ;;
  esac
}

# Chooses the native-session R2 gateway host without changing WRANGLER_DEV_IP.
# Native container sessions use the Docker-facing local interface or the host
# override; API-only native sessions keep loopback. Inside a devcontainer the
# gateway instead publishes a daemon-host relay and owns its final signed
# authority. Only the narrow S3 route is exposed, not Wrangler management APIs.
#
# @param $1 "true" when the container runtime is enabled for this session.
configure_local_r2_endpoint_host() {
  local containers_enabled=$1

  if [[ "$containers_enabled" == "true" ]]; then
    MELTIPLY_LOCAL_R2_HOST="${MELTIPLY_LOCAL_R2_HOST_OVERRIDE:-$(docker_host_address || printf '%s' "${WRANGLER_DEV_IP:-127.0.0.1}")}"
  else
    MELTIPLY_LOCAL_R2_HOST="127.0.0.1"
  fi
  export MELTIPLY_LOCAL_R2_HOST
}

# Appends non-secret loopback R2 variables for the direct API-only launcher.
# The native S3 prefix is part of the canonical URI, so signing and fetching must
# agree. Multi-Worker sessions instead obtain their single authority and prefix
# from the owned gateway launcher.
#
# @param $1 Name of the Bash array holding the Wrangler arguments.
# @param $2 Port the local Workers listen on.
append_local_r2_endpoint_overrides() {
  local args_name=$1
  local wrangler_port=$2
  local -n wrangler_args_ref="$args_name"

  [[ "${MELTIPLY_LOCAL_R2_HOST:-}" == "127.0.0.1" ]] || return 0
  local path_prefix="${LOCAL_R2_S3_PATH_PREFIX:-/cdn-cgi/local/r2/s3}"
  wrangler_args_ref+=(
    --var "R2_ENDPOINT:http://${MELTIPLY_LOCAL_R2_HOST}:${wrangler_port}"
    --var "R2_ENDPOINT_PATH_PREFIX:${path_prefix}"
  )
}

# Runs a multi-Worker session with one signed R2 authority and private temporary
# config/env paths: Wrangler otherwise applies CLI secrets/vars only to the
# primary config. Existing checkout env files stay untouched; API-only loopback
# sessions keep the direct entry. Both modes resolve PostgreSQL in the current
# namespace and export Hyperdrive overrides for every Worker, preserving explicit
# connection strings and leaving checked-in configs/env files untouched.
#
# @param $1 Repository root.
# @param $2 Worker listener port.
# @param $3 Name of the Bash array holding the complete Wrangler arguments.
exec_local_wrangler() {
  local repo_root=$1
  local wrangler_port=$2
  local args_name=$3
  local -n local_args_ref="$args_name"
  local postgres_endpoint
  postgres_endpoint="$(node "$repo_root/scripts/cloudflare-local/postgres-endpoint.mjs")"
  export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_AUTHENTICATED="${CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_AUTHENTICATED:-postgres://meltiply_rls:meltiply-authenticated-local@${postgres_endpoint}/meltiply?sslmode=disable}"
  export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_SYSTEM="${CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_SYSTEM:-postgres://meltiply_system:meltiply-system-local@${postgres_endpoint}/meltiply?sslmode=disable}"
  local worker_host="${WRANGLER_DEV_IP:-127.0.0.1}"
  local config_count=0 arg
  for arg in "${local_args_ref[@]}"; do
    if [[ "$arg" == "--config" ]]; then
      ((config_count += 1))
    fi
  done
  case "$worker_host" in
    0.0.0.0 | ::) worker_host=127.0.0.1 ;;
  esac
  if [[ "$config_count" -gt 1 || "${MELTIPLY_LOCAL_R2_HOST:-127.0.0.1}" != "127.0.0.1" ]]; then
    exec node "$repo_root/scripts/cloudflare-local/r2-gateway.mjs" \
      "$MELTIPLY_LOCAL_R2_HOST" "$worker_host" "$wrangler_port" \
      "$repo_root/node_modules/.bin/wrangler" "${local_args_ref[@]}"
  fi
  exec "$repo_root/node_modules/.bin/wrangler" "${local_args_ref[@]}"
}

# Runs the full local backend session shared by dev-backend.sh and
# dev-acceptance-backend.sh: root .env, namespace-local PostgreSQL, network
# resolution, the media-processor container gate, the signed R2 gateway, and the
# `wrangler dev` exec. Only the launcher differences arrive as parameters, so
# every environment and port precedence stays identical between sessions.
#
# Container policy is the launcher's contract for a disabled runtime:
# `advisory` lets WRANGLER_DEV_ENABLE_CONTAINERS=false skip the check so the
# stack still boots and processing reports the real failure; `required`
# rejects that opt-out outright (its only caller, the acceptance session,
# must publish normalized media). With containers enabled both policies exit
# when the runtime check fails; only the advisory remediation line differs.
#
# @param $1 Repository root.
# @param $2 Container policy: `advisory` or `required`.
# @param $3 Media-processor purpose quoted in runtime-check failures.
# @param $4 Session label printed in the startup banner.
# @param $@ `wrangler dev --config` paths in order: a multi-config session
#           serves unprefixed requests from the first config (the API Worker).
launch_local_wrangler_backend() {
  local repo_root=$1
  local container_policy=$2
  local container_purpose=$3
  local banner_label=$4
  shift 4

  cd "$repo_root"
  load_local_env "$repo_root/.env"

  "$repo_root/scripts/cloudflare-local/database.sh" start

  local wrangler_port="${requested_wrangler_port:-${WRANGLER_DEV_PORT:-8787}}"
  local frontend_port="${MELTIPLY_FRONTEND_PORT:-${FRONTEND_DEV_PORT:-3000}}"
  configure_local_wrangler_network "$repo_root" "$frontend_port" "$wrangler_port"

  local containers_enabled="${WRANGLER_DEV_ENABLE_CONTAINERS:-true}"
  if [[ "$containers_enabled" == "true" ]]; then
    # shellcheck source=container-runtime.sh
    source "$repo_root/scripts/cloudflare-local/container-runtime.sh"
    if ! require_container_runtime "$container_purpose"; then
      [[ "$container_policy" != "advisory" ]] || \
        printf 'Set WRANGLER_DEV_ENABLE_CONTAINERS=false to boot without processing.\n' >&2
      exit 1
    fi
  elif [[ "$container_policy" == "required" ]]; then
    printf 'Acceptance publication runs need WRANGLER_DEV_ENABLE_CONTAINERS=true.\n' >&2
    exit 1
  fi

  # Container callers need the Docker-facing listener's signed S3 endpoint;
  # the shared launcher supplies it without widening the API's configured bind.
  configure_local_r2_endpoint_host "$containers_enabled"
  # The gateway reports its final signed authority after allocating the relay.
  printf '%s using http://%s:%s\n' \
    "$banner_label" "${WRANGLER_DEV_IP:-127.0.0.1}" "$wrangler_port"

  # The sourced `.env` may contain shell, so re-anchor relative paths.
  cd "$repo_root"
  local wrangler_args=(dev) config
  for config in "$@"; do
    wrangler_args+=(--config "$config")
  done
  wrangler_args+=(
    --ip "${WRANGLER_DEV_IP:-127.0.0.1}"
    --port "$wrangler_port"
    --persist-to .wrangler/state
  )

  append_local_wrangler_env_file wrangler_args "$repo_root/.env"
  append_local_wrangler_overrides wrangler_args
  append_local_wrangler_container_flags wrangler_args

  exec_local_wrangler "$repo_root" "$wrangler_port" wrangler_args
}
