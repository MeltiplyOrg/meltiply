#!/usr/bin/env bash
# The pinned workerd proxy needs reverse-path filtering relaxed inside its own
# network namespace under DinD.
set -euo pipefail

sidecar_image='cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8'
state_dir="${TMPDIR:-/tmp}/meltiply-container-network-${UID}"

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
    [[ "$(docker inspect --format '{{.State.Pid}}' "$id" 2>/dev/null || true)" != "$pid" ]]
  }
}

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

start_watching() {
  if ! flock --nonblock "$state_dir/lock" true; then
    printf 'Network watcher already running; log: %s/watcher.log\n' "$state_dir"
    return 0
  fi
  nohup bash "$(realpath "${BASH_SOURCE[0]}")" watch >"$state_dir/watcher.log" 2>&1 </dev/null &
  printf 'Watching pinned Cloudflare proxies; log: %s/watcher.log\n' "$state_dir"
}

[[ "${MELTIPLY_DEVCONTAINER:-0}" == 1 && "${DOCKER_HOST:-unix:///var/run/docker.sock}" == unix:///var/run/docker.sock && ! -S /var/run/docker-host.sock && ! -L /var/run/docker.sock ]] || {
  printf 'container-network.sh requires the devcontainer local Docker-in-Docker daemon\n' >&2
  exit 1
}
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
