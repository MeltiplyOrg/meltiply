#!/usr/bin/env bash
set -euo pipefail

# cgroup v2 domain controllers require an empty parent; otherwise BuildKit creates
# a threaded /docker cgroup that rejects CPU/memory limits.
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
[[ -c /var/run/docker-host.sock && "$(stat -c '%t:%T' /var/run/docker-host.sock)" == "$(stat -c '%t:%T' /dev/null)" ]] || {
  printf 'DinD startup requires the inherited host socket to be masked with /dev/null\n' >&2
  exit 1
}

# Lifecycle hooks can begin before the image's synchronous entrypoint finishes; its
# detached proxy-supervising shells must not be awaited.
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

# pkill exits 1 when no process matches.
if sudo -n pkill --full '^socat UNIX-LISTEN:/var/run/docker.sock,.* UNIX-CONNECT:/var/run/docker-host.sock$'; then
  :
else
  status=$?
  [[ "$status" == 1 ]] || exit "$status"
fi
sudo -n /usr/local/share/docker-init.sh --start-daemon
