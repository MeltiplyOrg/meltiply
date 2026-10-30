#!/usr/bin/env bash
# Prepare cgroup v2 delegation before the image starts its inner Docker daemon.
# Requires privileged mode and a private cgroup namespace; never use host cgroups.
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
sudo -n "$0" --prepare-cgroups
exec /usr/local/share/docker-init.sh "$@"
