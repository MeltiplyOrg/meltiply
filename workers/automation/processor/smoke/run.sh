#!/usr/bin/env bash
# Orchestrates the native processor smoke (issue #284).
#
# Steps:
#   1. Build and run the REAL engine image for linux/amd64 even on an ARM host.
#   2. Generate/probe fixtures with the same codecs on the daemon's native CPU.
#   3. Start the fixture object service and the engine on one docker network.
#   4. Sample the engine's native processes from inside its own PID namespace
#      while the HTTP behavior regression suite drives real jobs.
#
# The isolated fixture service substitutes only object transport. Native codecs
# really decode and encode the bytes; Worker/R2/browser integration is separate.
#
# Prerequisite diagnosis is shared with the rest of the repo through
# scripts/cloudflare-local/container-runtime.sh (a bash helper), which is why
# this script runs under bash too.
#
# Modes:
#   strict (default): every container is bounded to the provisional standard-3
#     envelope (--cpus 2 --memory 8g) so a slow QEMU host cannot masquerade an
#     under-provisioned instance as passing. Requires a working cgroup v2
#     domain for the Docker daemon, which this script checks before the build
#     and never substitutes for: without it the run stops.
#   PROCESSOR_SMOKE_MEASURE_ONLY=1: omits ONLY the cgroup resource flags, for
#     hosts where the daemon's cgroup cannot enforce them. Byte-level proofs
#     still run for real and the engine's CPU/RSS is measured from /proc, but
#     the hard 2-CPU/8 GiB envelope is NOT verified and must not be claimed.
set -eu

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
SMOKE_DIR="$ROOT_DIR/smoke"
IMAGE="${SMOKE_IMAGE:-meltiply-processor-smoke${COMPOSE_PROJECT_NAME:+-$COMPOSE_PROJECT_NAME}}"
# Host-daemon bind mounts must live under the host-identical checkout, not the
# devcontainer's private /tmp. The private suffix also isolates concurrent runs.
TMP="$(mktemp -d "$ROOT_DIR/.smoke-tmp.XXXXXX")"
NETWORK="meltiply-processor-smoke-$(basename "$TMP")"
TOKEN="${PROCESSOR_JOB_TOKEN:-smoke-$(dd if=/dev/urandom bs=8 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')}"
# Fixture helpers use the host UID so the private mktemp bind mount stays private
# and writable. The engine itself still runs as the image's unprivileged user.
HOST_USER="$(id -u):$(id -g)"

MODE="strict"
RESOURCE_ARGS="--cpus 2 --memory 8g"
if [ "${PROCESSOR_SMOKE_MEASURE_ONLY:-}" = "1" ]; then
  MODE="measure_only"
  RESOURCE_ARGS=""
  echo "==> PROCESSOR_SMOKE_MEASURE_ONLY=1: cgroup resource flags omitted" >&2
  echo "    UNVERIFIED: the hard 2-CPU/8 GiB container envelope is NOT enforced" >&2
  echo "    this run. Byte-level proofs and measured CPU/RSS are real; remote" >&2
  echo "    Cloudflare deployment enforcement is likewise unverified here." >&2
fi

ENGINE_CONTAINER=""
FIXTURE_CONTAINER=""
MONITOR_PID=""
SUITE_RAN=""

BENCH_FILE="$TMP/benchmark.txt"
mkdir "$TMP/measure-state"
chmod 755 "$TMP/measure-state"

# Strict mode hands Docker --cpus/--memory, which runc applies only inside a
# cgroup v2 domain. Prove that before the image build and fixture generation,
# which would otherwise die on the first `docker run` with runc's cgroup error.
# The operator keeps the choice: the run stops with the host repair instead of
# degrading to measure-only behind their back.
if [ "$MODE" = "strict" ]; then
  # shellcheck source=../../../../scripts/cloudflare-local/container-runtime.sh
  . "$ROOT_DIR/../../../scripts/cloudflare-local/container-runtime.sh"
  require_container_cgroup_limits 'the strict processor smoke' || exit 1
  echo "==> strict mode: the daemon can enforce the CPU/memory envelope"
fi

# Requests a final sample through the shared stop marker before the exec client
# exits. This avoids QEMU's rewritten /proc cmdlines and remote-client signals;
# container teardown remains the final orphan safeguard.
stop_monitor() {
  [ -n "$MONITOR_PID" ] || return 0
  touch "$TMP/measure-state/stop"
  i=0
  while kill -0 "$MONITOR_PID" 2>/dev/null && [ "$i" -lt 50 ]; do
    sleep 0.1 2>/dev/null || sleep 1
    i=$((i + 1))
  done
  kill -KILL "$MONITOR_PID" 2>/dev/null || true
  wait "$MONITOR_PID" 2>/dev/null || true
  MONITOR_PID=""
}

# Emits the machine-readable benchmark line the sampler wrote, or an honest
# error object when the suite ran but the measurement was lost. Runs in the
# EXIT trap so a failed suite still reports before the temp dir is removed.
emit_benchmark() {
  if [ -s "$BENCH_FILE" ]; then
    cat "$BENCH_FILE"
  elif [ -n "$SUITE_RAN" ]; then
    printf 'BENCHMARK {"benchmark":"processor_smoke_engine_resources","error":"sampler produced no summary","mode":"%s"}\n' "$MODE"
  fi
  if [ -s "$BENCH_FILE.err" ]; then
    sed 's/^/monitor: /' "$BENCH_FILE.err" >&2
  fi
}

# EXIT trap: preserves the run's exit status, stops the sampler, emits the
# benchmark summary BEFORE the temp dir is removed, then tears down containers
# and network. Registered once so success, suite failure, and aborted runs all
# take the same teardown path.

cleanup() {
  status=$?
  stop_monitor
  emit_benchmark
  docker rm -f "$ENGINE_CONTAINER" "$FIXTURE_CONTAINER" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Snapshot scripts once: an editor changing a bind-mounted shell file mid-read
# can splice unrelated commands into a running fixture-generation process.
cp -R "$SMOKE_DIR" "$TMP/smoke"
SMOKE_DIR="$TMP/smoke"
case "$(docker info --format '{{.Architecture}}')" in
  amd64 | x86_64) TOOLS_PLATFORM="linux/amd64" ;;
  arm64 | aarch64) TOOLS_PLATFORM="linux/arm64" ;;
  *) echo "Unsupported Docker daemon fixture architecture" >&2; exit 1 ;;
esac
TOOLS_IMAGE="$IMAGE"

echo "==> building linux/amd64 processor image"
docker build --platform linux/amd64 -t "$IMAGE" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
if [ "$TOOLS_PLATFORM" != "linux/amd64" ]; then
  TOOLS_IMAGE="${IMAGE}-fixture-tools"
  echo "==> building native $TOOLS_PLATFORM fixture tools (engine remains linux/amd64)"
  docker build --platform "$TOOLS_PLATFORM" --build-arg "PROCESSOR_PLATFORM=$TOOLS_PLATFORM" \
    -t "$TOOLS_IMAGE" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
fi

echo "==> generating fixtures with the image's native tools ($MODE)"
# shellcheck disable=SC2086 # RESOURCE_ARGS is intentionally word-split flags.
docker run --rm --platform "$TOOLS_PLATFORM" --user "$HOST_USER" $RESOURCE_ARGS \
  -v "$TMP:/fixtures" -v "$SMOKE_DIR:/smoke:ro" \
  "$TOOLS_IMAGE" /bin/sh /smoke/make-fixtures.sh /fixtures/objects

echo "==> starting fixture object service and engine ($MODE)"
docker network create "$NETWORK" >/dev/null
FIXTURE_CONTAINER="$(docker run -d --platform "$TOOLS_PLATFORM" --user "$HOST_USER" \
  --network "$NETWORK" --network-alias fixtures \
  -v "$TMP:/fixtures" -v "$SMOKE_DIR:/smoke:ro" \
  -e FIXTURE_DIR=/fixtures "$TOOLS_IMAGE" node /smoke/fixtures-server.mjs)"
# Native controls bound each libvips/FFmpeg worker pool. They are not a hard
# process-tree CPU quota: measure-only mode reports actual combined consumption
# rather than claiming Docker's omitted 2-CPU envelope is enforced.
# shellcheck disable=SC2086 # RESOURCE_ARGS is intentionally word-split flags.
ENGINE_CONTAINER="$(docker run -d --platform linux/amd64 \
  $RESOURCE_ARGS \
  --network "$NETWORK" --network-alias engine \
  -v "$SMOKE_DIR:/smoke:ro" \
  -v "$TMP/measure-state:/measure-state:ro" \
  -e PROCESSOR_JOB_TOKEN="$TOKEN" \
  -e PROCESSOR_FFMPEG_THREADS=2 \
  -e VIPS_CONCURRENCY=2 \
  "$IMAGE")"

for i in $(seq 1 60); do
  if docker run --rm --platform "$TOOLS_PLATFORM" --network "$NETWORK" "$TOOLS_IMAGE" \
      node -e 'Promise.all([fetch("http://fixtures:8099/_objects"), fetch("http://engine:8080/healthz")]).then(([fixtures, engine]) => process.exit(fixtures.ok && engine.ok ? 0 : 1)).catch(() => process.exit(1));' \
      >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "engine or fixture service did not become ready" >&2
    docker logs "$ENGINE_CONTAINER" || true
    docker logs "$FIXTURE_CONTAINER" || true
    exit 1
  fi
  sleep 1
done

# The sampler execs into the engine container itself, so its /proc view is the
# engine's own PID namespace and it accounts exactly the engine subtree.
echo "==> sampling engine native processes from inside its PID namespace"
docker exec -e PROCESSOR_SMOKE_MODE="$MODE" -e PROCESSOR_SMOKE_STOP_FILE=/measure-state/stop \
  "$ENGINE_CONTAINER" node /smoke/measure.mjs \
  >"$BENCH_FILE" 2>"$BENCH_FILE.err" &
MONITOR_PID=$!

echo "==> running HTTP behavior regression suite ($MODE)"
SUITE_RAN=1
SUITE_STATUS=0
# shellcheck disable=SC2086 # RESOURCE_ARGS is intentionally word-split flags.
docker run --rm --platform "$TOOLS_PLATFORM" --user "$HOST_USER" $RESOURCE_ARGS \
  --network "$NETWORK" \
  -v "$TMP:/fixtures" -v "$SMOKE_DIR:/smoke:ro" \
  -e BASE_URL=http://engine:8080 \
  -e FIXTURE_URL=http://fixtures:8099 \
  -e FIXTURE_DIR=/fixtures \
  -e PROCESSOR_JOB_TOKEN="$TOKEN" \
  "$TOOLS_IMAGE" node /smoke/check.mjs || SUITE_STATUS=$?

# Preserve resource measurements before deliberately terminating the sampled
# process. The restart probe then proves output safety without its replay map.
stop_monitor
if [ "$SUITE_STATUS" -eq 0 ]; then
  docker run --rm --platform "$TOOLS_PLATFORM" --user "$HOST_USER" \
    --network "$NETWORK" -v "$TMP:/fixtures" -v "$SMOKE_DIR:/smoke:ro" \
    -e BASE_URL=http://engine:8080 -e FIXTURE_URL=http://fixtures:8099 \
    -e FIXTURE_DIR=/fixtures -e PROCESSOR_JOB_TOKEN="$TOKEN" \
    "$TOOLS_IMAGE" node /smoke/restart-check.mjs prepare || SUITE_STATUS=$?
fi
if [ "$SUITE_STATUS" -eq 0 ]; then
  docker restart "$ENGINE_CONTAINER" >/dev/null
  docker run --rm --platform "$TOOLS_PLATFORM" --user "$HOST_USER" \
    --network "$NETWORK" -v "$TMP:/fixtures" -v "$SMOKE_DIR:/smoke:ro" \
    -e BASE_URL=http://engine:8080 -e FIXTURE_URL=http://fixtures:8099 \
    -e FIXTURE_DIR=/fixtures -e PROCESSOR_JOB_TOKEN="$TOKEN" \
    "$TOOLS_IMAGE" node /smoke/restart-check.mjs verify || SUITE_STATUS=$?
fi

# EXIT trap stops the sampler, emits the benchmark summary, then removes the
# containers, network and temp dir, preserving the suite's exit status.
exit "$SUITE_STATUS"
