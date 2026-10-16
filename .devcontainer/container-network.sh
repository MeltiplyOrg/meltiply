#!/usr/bin/env bash
# Cloudflare's local proxy sidecar marks bridge traffic before reverse-path
# validation. WSL/VPN kernels inheriting src_valid_mark=1 then drop that traffic
# before the engine can start. Repair only the pinned sidecar's network
# namespace; never change the enclosing devcontainer, host, engine, or other
# Docker services.
#
# The Docker CLI now reaches a remote daemon (Docker Desktop), so host PIDs
# and nsenter cannot enter container namespaces. A short-lived privileged
# helper container joins the verified sidecar's network namespace via
# --network container:<id> and runs sysctl there instead. `start` runs one
# watcher as a daemon-scoped container: its reserved name prevents duplicate
# watchers across devcontainers, docker cp supplies this script, and output
# lands in `docker logs meltiply-container-network` rather than a log file.
set -euo pipefail

sidecar_image='cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8'
watcher_name='meltiply-container-network'
watcher_script='/container-network.sh'
sha_label='meltiply.network.script-sha'
project_label='meltiply.devcontainer.project'
state_dir="${TMPDIR:-/tmp}/meltiply-container-network-${UID}"
helper_image=''

# Prints this process's container ID. Two callers have different identities:
#
# - Inside the owning devcontainer (postStart `start` path and any manual
#   invocation) the owner is the container carrying the exact
#   meltiply.devcontainer.project=$COMPOSE_PROJECT_NAME label the launcher
#   applies at creation. That label survives the branch --hostname and the
#   daemon-side rename the launcher performs, so neither hostname nor name
#   can stand in; exactly one running match is required or the lookup fails
#   rather than guessing a sibling.
# - Inside the daemon-scoped watcher container (the `watch` path, which is
#   not a devcontainer and carries no project label) hostname/cgroup
#   identity still applies: the watcher sets no --hostname, so its hostname
#   remains its short ID, with /proc/self/cgroup as the fallback for cgroup
#   v1 and containerd v2 paths.
self_container() {
  if [[ "${MELTIPLY_DEVCONTAINER:-0}" == "1" ]]; then
    local owners count
    if ! owners="$(docker ps -q --no-trunc \
      --filter "label=${project_label}=${COMPOSE_PROJECT_NAME:-}")"; then
      printf 'docker ps failed resolving owning devcontainer\n' >&2
      return 1
    fi
    count="$(printf '%s\n' "$owners" | grep -c . || true)"
    if [[ "$count" != "1" ]]; then
      printf 'expected exactly one running owner labeled %s=%s, found %s\n' \
        "$project_label" "${COMPOSE_PROJECT_NAME:-}" "$count" >&2
      return 1
    fi
    printf '%s\n' "$owners"
    return 0
  fi
  local -r candidates="${HOSTNAME-}"$'\n'"$(tr '\0/' '\n\n' </proc/self/cgroup 2>/dev/null | grep -oE '[[:xdigit:]]{64}' | sort -u || true)"
  local candidate cid
  while read -r candidate; do
    [[ -n "$candidate" ]] || continue
    cid="$(docker inspect --format '{{.Id}}' "$candidate" 2>/dev/null)" || continue
    printf '%s\n' "$cid"
    return 0
  done <<<"$candidates"
  printf 'cannot identify this container via daemon\n' >&2
  return 1
}

# Prints the immutable image ID the repair helper runs. Resolution goes
# through the owning container's .Config.Image (the reference it was created
# container .Image can be an OCI-index digest the daemon cannot `docker run`
# (Docker Desktop), while the tag/digest in .Config.Image resolves through
# docker image inspect to the runnable image ID — even after the devcontainer
# CLI retags the image for UID alignment. MELTIPLY_REPAIR_IMAGE pins a
# reference instead; it is resolved the same way. The image is always cached,
# so the helper never triggers a pull.
repair_image() {
  if [[ -z "$helper_image" ]]; then
    local ref
    if [[ -n "${MELTIPLY_REPAIR_IMAGE-}" ]]; then
      ref=$MELTIPLY_REPAIR_IMAGE
    else
      ref="$(docker inspect --format '{{.Config.Image}}' "$(self_container)")"
    fi
    helper_image="$(docker image inspect --format '{{.Id}}' "$ref")"
  fi
  printf '%s\n' "$helper_image"
}

# Prints the daemon-side path to bind-mount into the watcher container as its
# Docker socket. Reuse the owning container's /var/run/docker-host.sock
# (mounted by the image's baked-in docker-outside-of-docker metadata; socat
# only proxies it for the devcontainer) or a /var/run/docker.sock source;
# either is the daemon's real API socket path, so the watcher talks to the
# daemon directly.
# MELTIPLY_HOST_DOCKER_SOCKET overrides; the final default is the daemon's
# conventional socket path, which is also the metadata's bind-mount source.
socket_source() {
  if [[ -n "${MELTIPLY_HOST_DOCKER_SOCKET-}" ]]; then
    printf '%s\n' "$MELTIPLY_HOST_DOCKER_SOCKET"
    return 0
  fi
  local cid mounts mdst dst src
  cid="$(self_container)"
  mounts="$(docker inspect --format '{{range .Mounts}}{{println .Destination .Source}}{{end}}' "$cid")"
  # Destination is printed first so a source path containing spaces still
  # reads intact as the remainder of the line.
  for mdst in /var/run/docker-host.sock /var/run/docker.sock; do
    while read -r dst src; do
      if [[ "$dst" == "$mdst" ]]; then
        printf '%s\n' "$src"
        return 0
      fi
    done <<<"$mounts"
  done
  printf '%s\n' /var/run/docker.sock
}

# Repairs one running, positively identified workerd proxy with its own
# network namespace (never host networking, never a shared container:*
# namespace). A privileged helper joins that namespace via
# --network container:<id>; the daemon is remote, so no host PID or nsenter
# is involved and the host network namespace is untouched. --user 0 overrides
# the image's non-root USER, without which the kernel denies the sysctl write
# despite --privileged, and --pull never turns a missing image into a visible
# error instead of a fetch. Older image tags declare DinD-style VOLUMEs
# (/var/lib/docker, /var/lib/containerd); bounded tmpfs mounts shadow them,
# and the helper never runs the image entrypoint — no anonymous volumes, no
# daemon in the helper either way.
# privilege and configuration failures stay visible. No VPN routes need
# marked RPF.
repair_sidecar() {
  local id=$1 metadata name image running network_mode
  metadata="$(docker inspect --format '{{.Name}} {{.Config.Image}} {{.State.Running}} {{.HostConfig.NetworkMode}}' "$id" 2>/dev/null)" || return 0
  read -r name image running network_mode <<<"$metadata"
  [[ "$name" == /workerd-*-proxy && "$image" == "$sidecar_image" && "$running" == true && "$network_mode" != host && "$network_mode" != container:* ]] || return 0
  local image_pid img
  image_pid="$(docker inspect --format '{{.State.Pid}}' "$id" 2>/dev/null)" || return 0
  img="$(repair_image)"
  if docker run --rm --pull never --user 0 --privileged --read-only \
    --tmpfs /var/lib/docker:rw,size=16m --tmpfs /var/lib/containerd:rw,size=16m \
    --network "container:$id" --entrypoint sysctl "$img" -w net.ipv4.conf.all.src_valid_mark=0; then
    return 0
  fi
  # A stop or restart between inspect and the helper run is harmless; a
  # still-running sidecar with the same PID means the repair genuinely
  # failed and must be reported.
  [[ "$(docker inspect --format '{{.State.Pid}}' "$id" 2>/dev/null || true)" != "$image_pid" ]]
}

# Keeps exactly one daemon-side watcher alive across devcontainers. The fixed
# container name is the lock: docker create fails while any holder exists, so
# competing postStart hooks cannot duplicate the watcher. A stopped (crashed
# or killed) holder, or one whose recorded script hash differs from this
# script, is reclaimed; a `created` holder younger than a minute is another
# postStart mid-handoff and is left alone. unless-stopped restarts the watcher
# after failures and daemon restarts; `docker logs meltiply-container-network`
# shows watcher and helper output. Older image tags declare DinD-style VOLUMEs
# (/var/lib/docker, /var/lib/containerd); bounded tmpfs mounts shadow them, and
# the watcher never runs the image entrypoint — no anonymous volumes, no
# daemon in the watcher either way.
ensure_watcher() {
  local -r image=$1 socket=$2 sha=$3
  # Root inside the watcher is honest privilege: the mounted socket is
  # root:docker with the daemon host's gid, which need not match the image's
  # docker group, and socket access is daemon-root regardless of container uid.
  local -ra spec=(--name "$watcher_name"
    --user 0
    --pull never
    --restart unless-stopped
    --network none
    --env DOCKER_HOST=unix:///var/run/docker.sock
    --volume "$socket:/var/run/docker.sock"
    --tmpfs /var/lib/docker:rw,size=16m
    --tmpfs /var/lib/containerd:rw,size=16m
    --label "$sha_label=$sha"
    --entrypoint bash
    "$image" "$watcher_script" watch)
  local create_out
  if ! create_out="$(docker create "${spec[@]}" 2>&1)"; then
    [[ "$create_out" == *"already in use"* ]] || { printf '%s\n' "$create_out" >&2; return 1; }
    local info status created script_sha
    info="$(docker inspect --format "{{.State.Status}}|{{.Created}}|{{index .Config.Labels \"$sha_label\"}}" "$watcher_name" 2>/dev/null)" \
      || { printf 'watcher container exists but cannot be inspected\n' >&2; return 1; }
    IFS='|' read -r status created script_sha <<<"$info"
    case $status in
      running|restarting)
        [[ "$script_sha" == "$sha" ]] && { printf 'Watcher already running in container %s\n' "$watcher_name"; return 0; }
        ;;
      created)
        local age=$(( $(date +%s) - $(date --date "$created" +%s 2>/dev/null || echo 0) ))
        (( age < 60 )) && { printf 'Watcher container is being set up by another postStart; leaving it\n'; return 0; }
        ;;
    esac
    docker rm -f "$watcher_name" >/dev/null
    docker create "${spec[@]}" >/dev/null
  fi
  docker cp "$4" "$watcher_name:$watcher_script" >/dev/null
  docker start "$watcher_name" >/dev/null
  printf 'Watching pinned Cloudflare sidecars via container %s (docker logs %s)\n' "$watcher_name" "$watcher_name"
}

# The devcontainer lifecycle hook must return quickly; the daemon-side watcher
# container is the durable process and needs no nohup/log plumbing of its own.
start_watching() {
  local image socket sha script
  script="$(realpath "${BASH_SOURCE[0]}")"
  image="$(repair_image)"
  socket="$(socket_source)"
  sha="$(sha256sum "$script" | cut -d' ' -f1)"
  ensure_watcher "$image" "$socket" "$sha" "$script"
}

# Refuses to run this copy alongside the live watcher container (for example a
# manual `watch` inside the devcontainer): the daemon-scoped name is the only
# dedup that survives postStart, and a foreign live holder always wins.
watcher_self_check() {
  local self_id holder_id
  self_id="$(self_container 2>/dev/null)" || self_id=''
  holder_id="$(docker inspect --format '{{.Id}}' "$watcher_name" 2>/dev/null)" || return 0
  [[ -z "$self_id" || "$holder_id" != "$self_id" ]] || return 0
  printf 'Watcher already running as container %s; see docker logs %s\n' "$watcher_name" "$watcher_name"
  exit 0
}

# Watches starts and repairs already-running sidecars after each daemon
# reconnect, running inside the watcher container. The event timestamp is
# taken before the initial scan, closing the scan/subscribe startup race; a
# genuine repair failure exits nonzero so the restart policy and container
# logs keep the failure visible. The flock only guards a manual `watch` in the
# devcontainer; the daemon-side name is the real lock.
watch_sidecars() {
  watcher_self_check
  exec 9>"$state_dir/lock"
  flock --nonblock 9 || return 0
  printf 'Watching pinned Cloudflare sidecar network namespaces\n'
  while true; do
    local since id
    since="$(date --iso-8601=seconds)"
    while read -r id; do
      [[ -z "$id" ]] || repair_sidecar "$id"
    done < <(docker ps --quiet --filter "ancestor=$sidecar_image")
    while read -r id; do
      [[ -z "$id" ]] || repair_sidecar "$id"
    done < <(docker events --since "$since" --filter type=container --filter event=start --format '{{.Actor.ID}}')
    sleep 1
  done
}

mkdir -p "$state_dir"
chmod 700 "$state_dir"
case "${1:-}" in
  start) start_watching ;;
  watch) watch_sidecars ;;
  *) printf 'usage: %s start|watch\n' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac
