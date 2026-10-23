#!/usr/bin/env bash
# Hermetic checks for doctor.sh: stub every external binary (node, docker,
# curl, ss, bun, uname, cloudflared), point the cgroup check at a fixture
# hierarchy, and drive the script through healthy, degraded (exit 2), and
# erroring (exit 1) environments without touching real processes or ports.
set -euo pipefail

# Model the declared host checkout, regardless of the caller's devcontainer,
# staged overlay, or custom stack ports. Container cases belong to compose tests.
unset COMPOSE_PROJECT_NAME MELTIPLY_DEVCONTAINER MELTIPLY_DEVCONTAINER_CONFIG \
  WRANGLER_DEV_PORT MELTIPLY_FRONTEND_PORT FRONTEND_DEV_PORT \
  MELTIPLY_CLOUDFLARE_POSTGRES_PORT

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT HUP INT TERM

mkdir -p "$fixture/bin" "$fixture/scripts/cloudflare-local"
cp "$repo_root/scripts/cloudflare-local/doctor.sh" \
  "$fixture/scripts/cloudflare-local/doctor.sh"
# The doctor shells out to the shared Compose boundary for every service
# probe, so the fixture checkout ships the real helper and a baseline file.
cp "$repo_root/scripts/cloudflare-local/compose.sh" \
  "$fixture/scripts/cloudflare-local/compose.sh"
printf 'services: {}\n' >"$fixture/compose.dev.yml"
chmod +x \
  "$fixture/scripts/cloudflare-local/doctor.sh" \
  "$fixture/scripts/cloudflare-local/compose.sh"

# Shared stub state.
export COMMAND_LOG="$fixture/commands.log"
export STUB_DIR="$fixture/bin"
# Every external binary the doctor calls resolves to a fixture stub first.
export PATH="$fixture/bin:$PATH"

# node prints the pinned version and resolves the dev host to loopback so the
# doctor probes 127.0.0.1 origins only. `development-host.mjs` is executed via
# `node <path>`, so the stub must handle that argv shape too.
cat >"$fixture/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version)
    printf 'v24.18.0\n'
    ;;
  *)
    # development-host.mjs invocation: print loopback regardless of args.
    printf '127.0.0.1\n'
    ;;
esac
EOF

cat >"$fixture/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf '1.4.2\n'
  exit 0
fi
if [[ "${1:-}" == "run" && "${2:-}" == "--no-install" && "${3:-}" == "wrangler" ]]; then
  # doctor runs: wrangler --version | tail -n 1 | tr -d "[:space:]"
  printf '4.148.0\n'
  exit 0
fi
printf 'bun %s\n' "$*" >>"${COMMAND_LOG:?}"
EOF

# Docker models the daemon's own view: its reported architecture via `info
# --format` and the execution platforms of the `default` buildx builder, since
# container_emulation_ready trusts daemon evidence over client-side probes.
cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"${COMMAND_LOG:?}"
# Docker and HTTP scenario flags are independent inputs to the doctor probe.
# An empty state models a healthy daemon with nothing running; ${DOCKER_STATE:?}
# would fake a dead daemon and surface live-stack runs as toolchain errors.
state="${DOCKER_STATE:-}"
case "$*" in
  info|compose\ version)
    exit 0
    ;;
  info\ --format*)
    printf '%s\n' "${STUB_DOCKER_ARCH:-x86_64}"
    exit 0
    ;;
  buildx\ inspect*)
    printf 'Name:      default\nPlatforms: %s\n' "${STUB_BUILDX_PLATFORMS:-linux/amd64}"
    exit 0
    ;;
  compose\ -f\ *--profile\ observability\ config\ --services)
    printf 'grafana\nloki\npostgres\nprometheus\npushgateway\ntempo\n'
    exit 0
    ;;
  compose\ -f\ *config\ --services)
    printf 'postgres\n'
    exit 0
    ;;
  compose\ -f\ *ps\ --status\ running*)
    if [[ "$state" == *"pg-running"* ]]; then
      printf 'meltiply-cloudflare-postgres-1\n'
    fi
    exit 0
    ;;
  compose\ -f\ *exec\ -T*psql*)
    if [[ "$state" == *"pg-queries"* || "$state" == *"pg-ok"* ]]; then
      printf ' ?column? \n---------\n        1\n(1 row)\n'
      exit 0
    fi
    exit 1
    ;;
esac
exit 0
EOF

cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC2124
curl_argv="$*"
printf 'curl %s\n' "$curl_argv" >>"${COMMAND_LOG:?}"
state="${CURL_STATE:-}" # empty = every endpoint refuses
url="${@: -1}"

# respond <code> <body>: emit the status code when curl asked for --write-out,
# the body otherwise. Checks the captured top-level argv, not "$*", which
# inside a function only sees the function arguments.
respond() {
  local code=$1 body=${2:-}
  if [[ "$curl_argv" == *--write-out* ]]; then
    printf '%s' "$code"
  else
    printf '%s' "$body"
  fi
}

case "$url" in
  */api/v1/health)
    if [[ "$state" == *"api-up"* ]]; then
      respond 200 '{"status":"ok"}'
    else
      exit 7
    fi
    ;;
  */api/v1/ready)
    if [[ "$state" == *"api-ready"* ]]; then
      respond 200 '{"status":"ready"}'
    else
      respond 503 '{"status":"unavailable"}'
    fi
    ;;
  */src/main.tsx)
    if [[ "$state" == *"frontend-up"* ]]; then
      printf 'import.meta.env = {"APP_URL": "%s"}' "${STUB_BAKED_ORIGIN:-http://127.0.0.1:3000}"
    else
      exit 7
    fi
    ;;
  http://127.0.0.1:3000/)
    if [[ "$state" == *"frontend-up"* ]]; then
      respond 200 '<!doctype html>'
    else
      exit 7
    fi
    ;;
  *)
    if [[ "$state" == *"baked-origin-up"* && "$url" == "${STUB_BAKED_ORIGIN:-}"* ]]; then
      respond 200 '{"status":"ok"}'
    else
      exit 7
    fi
    ;;
esac
EOF

cat >"$fixture/bin/ss" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${SS_STATE:-}" == *"port8787-held"* ]]; then
  printf 'LISTEN 0 511 0.0.0.0:8787 0.0.0.0:* users:(("mystery",pid=4242,fd=9))\n'
fi
exit 0
EOF


# cloudflared resolves through PATH on the real host, so whether the doctor
# reaches `dev-tunnel.sh named-possible` would otherwise depend on the machine
# running the tests. The stub keeps the connector deterministically present;
# the empty fixture HOME (no cert.pem) then makes named-possible decline, the
# same branch a logged-out workstation takes.
cat >"$fixture/bin/cloudflared" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# The doctor sources wrangler-env.sh and container-runtime.sh from its repo
# layout, and probes dev-tunnel.sh when cloudflared resolves. Give it a
# minimal checkout with every script it invokes plus a root .env with the
# required keys.
mkdir -p "$fixture/scripts/cloudflare-local"
cp "$repo_root/scripts/cloudflare-local/wrangler-env.sh" \
  "$fixture/scripts/cloudflare-local/wrangler-env.sh"
cp "$repo_root/scripts/cloudflare-local/container-runtime.sh" \
  "$fixture/scripts/cloudflare-local/container-runtime.sh"
cp "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" \
  "$fixture/scripts/cloudflare-local/dev-tunnel.sh"
cat >"$fixture/.env" <<'EOF'
BETTER_AUTH_SECRET=test-auth-secret
MAIL_FROM_ADDRESS=auth@example.test
TOKEN_ENCRYPTION_KEY=test-key
APP_URL=http://127.0.0.1:3000
EOF
mkdir -p "$fixture/node_modules"

# doctor invokes `.bin/tofu` relative to the checkout root, so the stub lives
# at $fixture/.bin/tofu, not on PATH.
mkdir -p "$fixture/.bin"
cat >"$fixture/.bin/tofu" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == version && "${2:-}" == -json ]]; then
  printf '{"terraform_version":"1.12.0"}\n'
  exit 0
fi
exit 0
EOF
chmod +x "$fixture/bin/node" "$fixture/bin/bun" "$fixture/bin/docker" \
  "$fixture/bin/curl" "$fixture/bin/ss" "$fixture/bin/cloudflared" \
  "$fixture/.bin/tofu"

# `uname` decides whether the amd64 processor image needs emulation, which
# depends on the host running the tests. The stub reports a fixed architecture
# and kernel so the container-runtime assertion is deterministic everywhere.
cat >"$fixture/bin/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  -m) printf '%s\n' "${STUB_ARCH:-x86_64}" ;;
  *) printf '%s\n' "${STUB_KERNEL:-Linux}" ;;
esac
EOF
chmod +x "$fixture/bin/uname"

# Two more host leaks get fixture state: HOME so `dev-tunnel.sh named-possible`
# finds no real cert.pem (and wrangler crash logs live under the fixture), and
# MELTIPLY_CGROUP_ROOT so the cgroup domain check reads this hierarchy — a
# domain root with a domain daemon cgroup — rather than the host kernel's.
export HOME="$fixture/home"
export TUNNEL_ORIGIN_CERT="$HOME/.cloudflared/cert.pem"
export MELTIPLY_CLOUDFLARED_BIN="$fixture/bin/cloudflared"
mkdir -p "$HOME" "$fixture/cgroup/docker"
export MELTIPLY_CGROUP_ROOT="$fixture/cgroup"
printf 'domain\n' >"$MELTIPLY_CGROUP_ROOT/cgroup.type"
printf 'domain\n' >"$MELTIPLY_CGROUP_ROOT/docker/cgroup.type"

run_doctor() {
  (cd "$fixture" && ./scripts/cloudflare-local/doctor.sh)
}

# Assert a required diagnostic and print its actual stream pair on failure.
expect_output() {
  # Both streams share the supplied path's basename; do not append twice.
  local file=$1 expected=$2 label=$3 base=${1%.*}
  if ! grep -Fq "$expected" "$file"; then
    printf 'doctor output missing %s in run: %s\n' "$label" "$expected" >&2
    printf 'captured stdout:\n' >&2
    cat "$base.stdout" >&2 2>/dev/null || true
    printf 'captured stderr:\n' >&2
    cat "$base.stderr" >&2 2>/dev/null || true
    exit 1
  fi
}

# Reject an unexpected diagnostic and print its actual stream pair on failure.
expect_absent() {
  local file=$1 unexpected=$2 label=$3 base=${1%.*}
  if grep -Fq "$unexpected" "$file"; then
    printf 'doctor output unexpectedly contains (%s): %s\n' "$label" "$unexpected" >&2
    cat "$base.stdout" >&2 2>/dev/null || true
    cat "$base.stderr" >&2 2>/dev/null || true
    exit 1
  fi
}

# Run 1: everything up — pg running+queryable, api healthy+ready on loopback,
# frontend serving, baked origin matches, no orphan workerd, empty ss.
export DOCKER_STATE="pg-running pg-queries"
export CURL_STATE="api-up api-ready frontend-up"
export SS_STATE=""
: >"$COMMAND_LOG"
run_doctor >"$fixture/r1.stdout" 2>"$fixture/r1.stderr" || code=$?
code=${code:-0}
expect_output "$fixture/r1.stdout" '[ok] Node v24.18.0' toolchain
expect_output "$fixture/r1.stdout" '[ok] API Worker healthy' health
expect_output "$fixture/r1.stdout" '[ok] API Worker ready' ready
expect_output "$fixture/r1.stdout" '[ok] Frontend dev server serving' frontend
expect_output "$fixture/r1.stdout" '[ok] Browser-baked API origin matches' baked
expect_output "$fixture/r1.stdout" 'fully healthy' summary
expect_output "$fixture/r1.stdout" '[ok] local container runtime can execute linux/amd64' container-runtime
expect_absent "$fixture/r1.stderr" '[error]' clean-stderr

# Run 1b: a threaded cgroup hierarchy must surface as a [note], never an
# error — the doctor treats it like missing emulation so the exit code stays
# clean. MELTIPLY_CGROUP_ROOT keeps this deterministic on every host.
printf 'threaded\n' >"$MELTIPLY_CGROUP_ROOT/docker/cgroup.type"
run_doctor >"$fixture/r1b.stdout" 2>"$fixture/r1b.stderr" || code=$?
code=${code:-0}
expect_output "$fixture/r1b.stdout" "[note] $fixture/cgroup/docker/cgroup.type is threaded" cgroup-threaded
expect_output "$fixture/r1b.stdout" 'fully healthy' summary
expect_absent "$fixture/r1b.stderr" '[error]' clean-stderr
printf 'domain\n' >"$MELTIPLY_CGROUP_ROOT/docker/cgroup.type"

# Run 2: frontend alive, API dead — degraded exit 2 with the banner explanation,
# and no orphan-workerd false positive for a vite-parented runtime.
export DOCKER_STATE="pg-running pg-queries"
export CURL_STATE="frontend-up baked-origin-up"
export STUB_BAKED_ORIGIN="http://127.0.0.1:8787"
export SS_STATE="port8787-held"
run_doctor >"$fixture/r2.stdout" 2>"$fixture/r2.stderr" || code=$?
code=${code:-0}
expect_output "$fixture/r2.stdout" 'could not refresh this view' cross-check
expect_output "$fixture/r2.stderr" 'live-stack problem(s)' summary-degraded

# Run 2b: a non-amd64 host that is not Linux still runs the amd64 image through
# the Docker daemon's own emulation, which no host probe can see. The doctor must
# report it as available instead of raising a false prerequisite note.
export STUB_ARCH="arm64"
export STUB_KERNEL="Darwin"
run_doctor >"$fixture/r2b.stdout" 2>"$fixture/r2b.stderr" || code=$?
code=${code:-0}
expect_output "$fixture/r2b.stdout" '[ok] local container runtime can execute linux/amd64' container-runtime
unset STUB_ARCH STUB_KERNEL
# Run 2c: a non-amd64 Linux host whose client namespace may hide binfmt_misc
# still runs the image when the daemon reports amd64 itself; the daemon's
# platform list is the evidence, not the invisible client procfs entry.
export STUB_ARCH="aarch64"
export STUB_KERNEL="Linux"
export STUB_DOCKER_ARCH="aarch64"
export STUB_BUILDX_PLATFORMS="linux/arm64, linux/amd64, linux/amd64/v2"
run_doctor >"$fixture/r2c.stdout" 2>"$fixture/r2c.stderr" || code=$?
expect_output "$fixture/r2c.stdout" '[ok] local container runtime can execute linux/amd64' container-runtime

# Run 2d: the same host with a daemon that reports no amd64 platform must get
# the prerequisite note and the emulation remediation, never a false ok.
export STUB_BUILDX_PLATFORMS="linux/arm64"
run_doctor >"$fixture/r2d.stdout" 2>"$fixture/r2d.stderr" || code=$?
expect_output "$fixture/r2d.stdout" '[note] no linux/amd64 execution on this aarch64 host' container-runtime
expect_output "$fixture/r2d.stderr" 'docker run --privileged --rm tonistiigi/binfmt --install amd64' remediation
unset STUB_ARCH STUB_KERNEL STUB_DOCKER_ARCH STUB_BUILDX_PLATFORMS
# Run 3: broken prerequisites — wrong Node version, missing env keys, stopped
# postgres; hard errors must dominate with exit 1.
cat >"$fixture/bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'v20.99.0\n'
EOF
chmod +x "$fixture/bin/node"
sed -i '/^BETTER_AUTH_SECRET=/d' "$fixture/.env"
export DOCKER_STATE=""
export CURL_STATE=""
export SS_STATE=""
run_doctor >"$fixture/r3.stdout" 2>"$fixture/r3.stderr" || code=$?
code=${code:-0}
expect_output "$fixture/r3.stderr" '[error] Node v24.18.0' node-error
expect_output "$fixture/r3.stderr" '[error] root .env has Better Auth/mail/encryption configuration' env-error
expect_output "$fixture/r3.stderr" 'doctor found 2 error(s)' error-summary
# Run 4: crashed last wrangler session surfaces the Network connection lost
# hint. HOME already points at the fixture, so the log drops into it directly.
cat >"$fixture/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --version)
    printf 'v24.18.0\n'
    ;;
  *)
    printf '127.0.0.1\n'
    ;;
esac
EOF
chmod +x "$fixture/bin/node"
mkdir -p "$HOME/.config/.wrangler/logs"
cat >"$HOME/.config/.wrangler/logs/wrangler-2026-08-22_05-36-31_555.log" <<'EOF'
--- debug
Error in ProxyController: Error inside ProxyWorker
cause:
message: 'Network connection lost.'
---
EOF
export DOCKER_STATE="pg-running pg-queries"
export CURL_STATE="api-up api-ready frontend-up"
export SS_STATE=""
run_doctor >"$fixture/r4.stdout" 2>"$fixture/r4.stderr" || code=$?
code=${code:-0}
expect_output "$fixture/r4.stderr" 'wrangler-2026-08-22_05-36-31_555.log' crash-log-path
# Read-only diagnostics: the log must survive the doctor.
[[ -f "$HOME/.config/.wrangler/logs/wrangler-2026-08-22_05-36-31_555.log" ]]

printf 'cloudflare local doctor tests passed\n'
