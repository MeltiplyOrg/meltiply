#!/usr/bin/env bash
# Repair only the pinned workerd proxy's reverse-path filtering under DinD.
# The inner daemon's PIDs are local, so nsenter needs no helper image or socket
# forwarding. Never change the devcontainer's or outer host's network namespace.
set -euo pipefail

sidecar_image='cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8'
state_dir="${TMPDIR:-/tmp}/meltiply-container-network-${UID}"

# Repairs a positively identified running proxy in its private network namespace.
# A disappeared proxy is harmless; real sysctl failures are returned and logged
# by the watcher. Namespace identity is rechecked after entering it to avoid
# changing the daemon host namespace even if the proxy exits and its PID is reused.
repair_sidecar() {
  local id=$1 metadata name image running network_mode pid namespace
  metadata="$(docker inspect --format '{{.Name}} {{.Config.Image}} {{.State.Running}} {{.HostConfig.NetworkMode}} {{.State.Pid}}' "$id" 2>/dev/null)" || return 0
  read -r name image running network_mode pid <<<"$metadata"
  [[ "$name" == /workerd-*-proxy && "$image" == "$sidecar_image" && "$running" == true && "$network_mode" != host && "$network_mode" != container:* ]] || return 0
  namespace="$(sudo -n readlink "/proc/$pid/ns/net")" || return 0
  [[ "$namespace" != "$(readlink /proc/self/ns/net)" ]] || return 1
  sudo -n nsenter --target "$pid" --net bash -euc '
    test "$(readlink /proc/self/ns/net)" = "$1"
    sysctl -w net.ipv4.conf.all.src_valid_mark=0
  ' _ "$namespace" || {
    # A stop/restart during nsenter is not a persistent repair failure.
    [[ "$(docker inspect --format '{{.State.Pid}}' "$id" 2>/dev/null || true)" != "$pid" ]]
  }
}

# Watches starts and existing proxies, reconnecting after daemon interruptions.
# One flock per devcontainer deduplicates lifecycle/manual invocations. Take the
# event timestamp before scanning so starts between scan and subscribe are seen.
# Repair failures stay visible in the log; later starts/scans retry them.
watch_sidecars() {
  exec 9>"$state_dir/lock"
  flock --nonblock 9 || return 0
  while true; do
    local since id
    since="$(date --iso-8601=seconds)"
    while read -r id; do
      if [[ -n "$id" ]] && ! repair_sidecar "$id"; then
        printf 'Failed to repair pinned proxy %s\n' "$id" >&2
      fi
    done < <(docker ps --quiet --filter "ancestor=$sidecar_image")
    while read -r id; do
      if [[ -n "$id" ]] && ! repair_sidecar "$id"; then
        printf 'Failed to repair pinned proxy %s\n' "$id" >&2
      fi
    done < <(docker events --since "$since" --filter type=container --filter event=start --format '{{.Actor.ID}}')
    sleep 1
  done
}

# Starts a detached watcher without delaying the lifecycle hook. The watcher
# holds its own flock, so concurrent starts cannot produce duplicate listeners.
# Logs live inside this devcontainer rather than the outer Docker daemon.
start_watching() {
  if ! flock --nonblock "$state_dir/lock" true; then
    printf 'Network watcher already running; log: %s/watcher.log\n' "$state_dir"
    return 0
  fi
  nohup bash "$(realpath "${BASH_SOURCE[0]}")" watch >"$state_dir/watcher.log" 2>&1 </dev/null &
  printf 'Watching pinned Cloudflare proxies; log: %s/watcher.log\n' "$state_dir"
}

# This script requires a local DinD daemon, never a forwarded host API socket.
[[ "${MELTIPLY_DEVCONTAINER:-0}" == 1 && "${DOCKER_HOST:-unix:///var/run/docker.sock}" == unix:///var/run/docker.sock && ! -e /var/run/docker-host.sock && ! -L /var/run/docker.sock ]] || {
  printf 'container-network.sh requires the devcontainer local Docker-in-Docker daemon\n' >&2
  exit 1
}
# Lifecycle hooks may begin while the image entrypoint is still delegating cgroups.
for attempt in {1..60}; do
  if docker info >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 60 ]]; then
    printf 'Local Docker daemon did not become ready; see /var/log/dockerd.log\n' >&2
    exit 1
  fi
  sleep 1
done
mkdir -p "$state_dir"
chmod 700 "$state_dir"
case "${1:-}" in
  start) start_watching ;;
  watch) watch_sidecars ;;
  *) printf 'usage: %s start|watch\n' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac
