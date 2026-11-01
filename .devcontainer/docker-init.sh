#!/usr/bin/env bash
# Select the original image's bundled DinD daemon without rebuilding the image.
# The config masks its inherited host-socket mount with /dev/null. Prepare private
# cgroups and stop the image's inert DooD proxy before starting its local daemon.
set -euo pipefail

# Enables the available controllers under this container's cgroup namespace root.
# Move startup processes to a leaf first: cgroup v2 domain controllers require an
# empty parent. This prevents BuildKit creating a threaded /docker cgroup that
# later rejects processor CPU/memory limits. v1 needs no preparation. Concurrent
# CLI execs can briefly repopulate the root, so startup is bounded and failures
# stay visible instead of silently running Docker without resource isolation.
prepare_cgroups() {
  local root=/sys/fs/cgroup pid controllers attempt
  [[ -f "$root/cgroup.controllers" ]] || return 0
  controllers="$(cat "$root/cgroup.controllers")"
  [[ -n "$controllers" ]] || { echo 'No delegated cgroup v2 controllers available' >&2; return 1; }
  mkdir -p "$root/init"
  for attempt in {1..30}; do
    while read -r pid; do
      printf '%s\n' "$pid" >"$root/init/cgroup.procs" 2>/dev/null || true
    done <"$root/cgroup.procs"
    if printf '+%s\n' "${controllers// / +}" >"$root/cgroup.subtree_control"; then
      return 0
    fi
    sleep 0.1
  done
  printf 'Cannot delegate cgroup controllers for Docker-in-Docker\n' >&2
  return 1
}

if [[ "${1:-}" == --prepare-cgroups ]]; then
  prepare_cgroups
  exit
fi
# Refuse to bootstrap against a real host socket. The expected mount is /dev/null.
[[ -c /var/run/docker-host.sock && "$(stat -c '%t:%T' /var/run/docker-host.sock)" == "$(stat -c '%t:%T' /dev/null)" ]] || {
  printf 'DinD startup requires the inherited host socket to be masked with /dev/null\n' >&2
  exit 1
}

# Hooks can begin before the image's synchronous metadata entrypoint finishes.
# Only its direct child of the CLI's /bin/sh is startup work: the image also
# leaves detached Bash shells supervising its proxy, which must not be awaited.
for attempt in {1..60}; do
  initializing=false
  while read -r pid; do
    parent="$(ps -o ppid= -p "$pid")" || continue
    parent="${parent//[[:space:]]/}"
    if [[ "$(ps -o comm= -p "$parent")" == sh ]]; then initializing=true; fi
  done < <(pgrep --full '(^|/)bash /usr/local/share/docker-init.sh$' || true)
  if [[ "$initializing" == false ]]; then break; fi
  [[ "$attempt" != 60 ]] || { echo 'Image Docker initialization did not finish' >&2; exit 1; }
  sleep 1
done
if [[ ! -L /var/run/docker.sock ]] && docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; then
  exit
fi
sudo -n bash "$(realpath "${BASH_SOURCE[0]}")" --prepare-cgroups

# The upstream entrypoint may have started a proxy against the inert mount.
# Stop only that exact proxy; pkill status 1 means there is no matching process.
if sudo -n pkill --full '^socat UNIX-LISTEN:/var/run/docker.sock,.* UNIX-CONNECT:/var/run/docker-host.sock$'; then
  :
else
  status=$?
  [[ "$status" == 1 ]] || exit "$status"
fi
sudo -n /usr/local/share/docker-init.sh --start-daemon
