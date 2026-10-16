#!/usr/bin/env bash
# Shared checks for the local Cloudflare Container runtime.
#
# Cloudflare runs containers on. `wrangler dev` and the engine smoke both build
# and execute that image with the host Docker daemon, so a non-amd64 daemon
# additionally needs QEMU user-mode emulation registered for x86-64. The
# second prerequisite is the cgroup hierarchy: Docker's `--cpus`/`--memory`
# are domain controllers, so container_cgroup_limits_ready reports a threaded
# daemon cgroup before anything is built instead of letting the first
# `docker run` fail with runc's opaque cgroup error. Source this after
# `set -euo pipefail`; it only defines functions.

# Prints the processor's required image platform.
#
# Deployed containers and `wrangler dev` both run linux/amd64; the value is kept
# in one place so a future platform change cannot leave a check behind.
container_image_platform() {
  printf 'linux/amd64\n'
}

# Reports whether the Docker runtime can execute the amd64 processor image.
#
# The daemon is authoritative whenever it answers: `docker info` reports its
# native architecture, and the `default` buildx builder's `Platforms:` list
# names every platform the daemon itself executes, including QEMU-emulated
# ones and `/v2` variants — so a listed amd64 proves support and its absence
# disproves it. Only when the daemon cannot answer does the check fall back
# to client-side probes: a native amd64 kernel, a non-Linux client OS whose
# desktop Docker emulates inside an invisible VM, or a qemu-x86_64 entry in
# this client's /proc/sys/fs/binfmt_misc. Kernel handlers are global but
# mount-namespace visibility is not, so an empty client view is never treated
# as proof a handler is missing; the procfs entry is also only evidence for a
# daemon that shares this kernel.
#
# @return 0 when amd64 execution is supported, non-zero otherwise. Starts and
#         pulls nothing: diagnosis stays read-only.
container_emulation_ready() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    case "$(docker info --format '{{.Architecture}}' 2>/dev/null)" in
      x86_64 | amd64) return 0 ;;
    esac
    local platforms
    platforms="$(
      docker buildx inspect default 2>/dev/null |
        sed -n 's/^Platforms:[[:space:]]*//p'
    )"
    if [[ -n "$platforms" ]]; then
      grep -Eq '(^|[[:space:],])linux/amd64([[:space:],/]|$)' <<<"$platforms" &&
        return 0
      return 1
    fi
  fi
  case "$(uname -m)" in
    x86_64 | amd64) return 0 ;;
  esac
  [[ "$(uname -s)" != "Linux" ]] && return 0
  [[ -e /proc/sys/fs/binfmt_misc/qemu-x86_64 ]]
}

# Prints the remediation for a host where container_emulation_ready fails.
#
# QEMU user-mode handlers must be registered with the kernel of the machine the
# daemon runs on; Docker's binfmt image performs exactly that registration, so
# every caller shares one remediation string instead of re-wording it.
#
# @return 0 and print the remediation command with a trailing newline.
container_emulation_hint() {
  printf 'docker run --privileged --rm tonistiigi/binfmt --install amd64\n'
}

# Prints the unified (cgroup v2) hierarchy mount point the checks below read.
#
# MELTIPLY_CGROUP_ROOT overrides the real /sys/fs/cgroup so hermetic tests can
# point the checks at a fixture hierarchy instead of the host kernel's.
#
# @return 0 and print the absolute path with a trailing newline.
container_cgroup_root() {
  printf '%s\n' "${MELTIPLY_CGROUP_ROOT:-/sys/fs/cgroup}"
}

# Prints the cgroup directory a default-configured daemon puts containers in.
#
# The `cgroupfs` driver writes each container to <root>/docker/<id> on a
# unified (v2) hierarchy, so that directory's `cgroup.type` decides whether
# cpu/memory can be charged there at all. A daemon configured with a custom
# `cgroup-parent` keeps its containers elsewhere; the check below then reads
# the hierarchy root, which still proves or disproves a threaded ancestor.
#
# @return 0 and print the absolute path with a trailing newline.
container_daemon_cgroup() {
  printf '%s/docker\n' "$(container_cgroup_root)"
}

# Reports whether this host's daemon can enforce CPU/memory limits.
#
# runc enters a cgroup v2 *domain* only, so a container asked for in a
# threaded cgroup is refused before it starts ("cannot enter cgroupv2 ... it
# is in threaded mode"). `cgroup.type` is exactly the fact the kernel applies,
# so reading it for the hierarchy root and for the daemon's container parent
# settles the question read-only, without building or pulling anything.
#
# Two situations deliberately report ready rather than guessing: a legacy
# (v1) hierarchy has no `cgroup.type` and enforces limits through its own
# per-controller files, and a client that sees no unified hierarchy at all
# (macOS, or a daemon running on another machine) cannot see the failing
# kernel at all — there the daemon's own `docker run` remains the authority.
#
# @return 0 when limits are enforceable or undecidable from this client,
#         non-zero when a threaded cgroup is proven to stand in the way.
container_cgroup_limits_ready() {
  local cgroup_root
  cgroup_root="$(container_cgroup_root)"
  [ -f "$cgroup_root/cgroup.type" ] || return 0
  case "$(cat "$cgroup_root/cgroup.type" 2>/dev/null)" in
  *threaded*) return 1 ;;
  esac
  # A domain root still hands threaded cgroups to its children while threaded
  # mode is enabled on its subtree, so the daemon's own parent is decisive.
  case "$(cat "$(container_daemon_cgroup)/cgroup.type" 2>/dev/null)" in
  *threaded*) return 1 ;;
  esac
  return 0
}

# Prints the remediation for a daemon whose container cgroup is threaded.
#
# The kernel only converts a threaded cgroup back to a domain when it is empty
# *and* its parent already is a domain, so a daemon nested under a threaded
# namespace root cannot be repaired from inside that hierarchy: the repair
# belongs to whatever created it. One line therefore names that host-side
# change; require_container_cgroup_limits prints the conversion command that
# only becomes valid afterwards.
#
# @return 0 and print the remediation with a trailing newline.
container_cgroup_hint() {
  printf 'recreate this environment so the Docker daemon runs in a cgroup v2 DOMAIN cgroup, then restart dockerd\n'
}

# Fails the caller unless the local runtime can enforce CPU/memory limits.
#
# @param $1 Human-readable use of the runtime, quoted for the failure line.
# @return 0 when container limits can be applied; non-zero after printing the
#         threaded cgroup that blocks them, why runc refuses it, and the
#         remediation followed by the post-repair conversion command.
require_container_cgroup_limits() {
  local purpose=$1
  local daemon_cgroup
  daemon_cgroup="$(container_daemon_cgroup)"
  if container_cgroup_limits_ready; then
    return 0
  fi
  printf '%s needs Docker CPU/memory limits, but %s is a threaded cgroup\n' \
    "$purpose" "$daemon_cgroup" >&2
  printf '       runc cannot enter a threaded cgroup with domain controllers\n' >&2
  printf '       %s\n' "$(container_cgroup_hint)" >&2
  printf '       after that, empty the cgroup and convert it: docker rm -f $(docker ps -aq) && echo domain > %s/cgroup.type\n' \
    "$daemon_cgroup" >&2
  return 1
}

# Prints this namespace's listener address on the route to Docker's gateway.
#
# Native hosts use their bridge interface; devcontainers use their own address
# so sibling processor containers can reach the signed R2 listener. The daemon's
# gateway is a route target, not necessarily an address this process can bind.
#
# @return 0 and print the local address, or 1 when it cannot be determined.
docker_host_address() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  local gateway
  gateway="$(
    docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' \
      2>/dev/null || true
  )"
  [[ -n "$gateway" ]] || return 1
  node "$(dirname "${BASH_SOURCE[0]}")/docker-listener-host.mjs" "$gateway"
}

# Fails the caller unless the local container runtime can run the engine image.
#
# @param $1 Human-readable use of the runtime, quoted for the failure line.
# @return 0 when Docker is reachable and amd64 execution is possible; non-zero
#         after printing the missing prerequisite and its remediation.
require_container_runtime() {
  local purpose=$1
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    printf '%s needs a reachable Docker daemon\n' "$purpose" >&2
    return 1
  fi
  if container_emulation_ready; then
    return 0
  fi
  printf '%s needs %s images, but this %s host has no amd64 emulation\n' \
    "$purpose" "$(container_image_platform)" "$(uname -m)" >&2
  printf '       %s\n' "$(container_emulation_hint)" >&2
  return 1
}