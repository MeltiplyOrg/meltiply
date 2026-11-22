#!/usr/bin/env bash
set -eu

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
SMOKE_DIR="$ROOT_DIR/smoke"
IMAGE="${SMOKE_IMAGE:-meltiply-processor-smoke${COMPOSE_PROJECT_NAME:+-$COMPOSE_PROJECT_NAME}}"
# The host daemon resolves bind mounts against the host-identical checkout, not the
# devcontainer's private /tmp.
TMP="$(mktemp -d "$ROOT_DIR/.smoke-tmp.XXXXXX")"
NETWORK="meltiply-processor-smoke-$(basename "$TMP")"
TOKEN="${PROCESSOR_JOB_TOKEN:-smoke-$(dd if=/dev/urandom bs=8 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')}"
HOST_USER="$(id -u):$(id -g)"

MODE="strict"
RESOURCE_ARGS="--cpus 2 --memory 8g"
if [ "${PROCESSOR_SMOKE_UNBOUNDED:-}" = "1" ]; then
  MODE="unbounded"
  RESOURCE_ARGS=""
  echo "UNVERIFIED: CPU/memory envelope is not enforced in unbounded mode." >&2
fi

ENGINE_CONTAINER=""
FIXTURE_CONTAINER=""

# runc applies Docker --cpus/--memory only inside a cgroup v2 domain.
if [ "$MODE" = "strict" ]; then
  # shellcheck source=../../../../scripts/cloudflare-local/container-runtime.sh
  . "$ROOT_DIR/../../../scripts/cloudflare-local/container-runtime.sh"
  require_container_cgroup_limits 'the strict processor smoke' || exit 1
  echo "==> strict mode: the daemon can enforce the CPU/memory envelope"
fi

cleanup() {
  status=$?
  docker rm -f "$ENGINE_CONTAINER" "$FIXTURE_CONTAINER" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Bash reads scripts incrementally, so editing a bind-mounted script mid-run can
# splice in unrelated commands.
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
# Native thread limits bound each libvips/FFmpeg worker pool independently.
# shellcheck disable=SC2086 # RESOURCE_ARGS is intentionally word-split flags.
ENGINE_CONTAINER="$(docker run -d --platform linux/amd64 \
  $RESOURCE_ARGS \
  --network "$NETWORK" --network-alias engine \
  -v "$SMOKE_DIR:/smoke:ro" \
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

echo "==> running HTTP behavior regression suite ($MODE)"
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

exit "$SUITE_STATUS"
