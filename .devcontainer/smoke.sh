#!/usr/bin/env bash
# Exercise the real devcontainer config on a disposable GitHub-hosted runner.
# Requires Docker and Dev Container CLI; creates placeholder credential mounts
# but skips credential-dependent lifecycle setup. Never run on a developer host.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Use a disposable GitHub Actions runner' >&2; exit 1; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
mkdir -p "$HOME/.omp" "$HOME/.config/gh" "$HOME/.config/.wrangler"
touch "$HOME/.wakatime.cfg"
container=''

# Reports daemon logs on failure; the disposable runner owns all smoke resources.
cleanup() {
  local status=$?
  if [[ "$status" != 0 && -n "$container" ]]; then
    docker logs "$container" || true
    docker exec -u root "$container" cat /var/log/dockerd.log || true
  fi
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null || true; fi
}
trap cleanup EXIT

# The CLI can return before the image entrypoint completes when hooks are skipped.
# Wait for readiness after creation/restart; a dead container fails immediately.
wait_for_docker() {
  local attempt
  for attempt in {1..60}; do
    if docker exec "$container" docker info >/dev/null 2>&1; then return 0; fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]] || break
    sleep 1
  done
  echo 'Inner Docker daemon did not become ready' >&2
  return 1
}

docker run -d --name meltiply-outer-proof busybox:1.37.0 sleep 600 >/dev/null
result="$(devcontainer up --workspace-folder "$repo_root" --skip-post-create)"
container="$(jq -r .containerId <<<"$result")"
# Credential-dependent hooks are skipped; invoke the same DinD bootstrap manually.
docker exec "$container" bash /opt/meltiply-devcontainer/docker-init.sh
wait_for_docker
test "$(docker inspect --format '{{.HostConfig.Privileged}}' "$container")" = true
docker inspect "$container" | jq -e '.[0].Mounts | all(.[]; if .Destination == "/var/run/docker-host.sock" then .Type == "bind" and .Source == "/dev/null" and .RW == false else .Destination != "/var/run/docker.sock" end)' >/dev/null
docker inspect "$container" | jq -e '.[0].Mounts | any(.[]; .Type == "volume" and .Destination == "/var/lib/docker") and any(.[]; .Type == "volume" and .Destination == "/var/lib/containerd")' >/dev/null
outer_daemon="$(docker info --format '{{.ID}}')"
inner_daemon="$(docker exec "$container" docker info --format '{{.ID}}')"
test "$outer_daemon" != "$inner_daemon"

docker exec --workdir "$repo_root" "$container" bash -euc '
  test "$(id -un)" = dev
  test -c /var/run/docker-host.sock
  test ! -L /var/run/docker.sock
  if docker inspect meltiply-outer-proof >/dev/null 2>&1; then exit 1; fi
  build_dir=$(mktemp -d)
  printf "%s\n" "FROM busybox:1.37.0" "RUN echo nested-docker-works > /proof" "CMD [\"cat\", \"/proof\"]" > "$build_dir/Dockerfile"
  docker buildx build --load -t meltiply-inner-proof:local "$build_dir"
  test "$(docker run --rm --memory 64m --cpus 0.5 meltiply-inner-proof:local)" = nested-docker-works
  docker run -d --name meltiply-inner-proof busybox:1.37.0 sleep 600
  ./scripts/cloudflare-local/compose.sh --profile observability config --format json > /tmp/meltiply-compose.json
  jq -e '\''.services | all(.[]; .network_mode == "host" and ((.ports // []) | length == 0))'\'' /tmp/meltiply-compose.json
  ./scripts/cloudflare-local/compose.sh up -d --wait postgres
  test "$(node scripts/cloudflare-local/postgres-endpoint.mjs)" = 127.0.0.1:5433
  test "$(./scripts/cloudflare-local/compose.sh exec -T postgres psql -U postgres -d meltiply -tAc "SELECT 42")" = 42
  bash /opt/meltiply-devcontainer/container-network.sh start
  bash /opt/meltiply-devcontainer/container-network.sh start
  sleep 1
  test "$(pgrep -fc "^bash /opt/meltiply-devcontainer/container-network.sh watch$")" = 1
  ./scripts/cloudflare-local/compose.sh down -v
  rm -rf "$build_dir"
'
docker exec -i --workdir "$repo_root" "$container" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
const exec = promisify(execFile);
const host = execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).trim();
const upstream = createServer((request, response) => {
  response.setHeader("content-type", "application/octet-stream");
  response.end(`upstream:${request.url}`);
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const gateway = spawn("node", [
  "scripts/cloudflare-local/r2-gateway.mjs", host, "127.0.0.1",
  String(upstream.address().port), "node", "-e", "setInterval(() => {}, 1000)", "--",
], { stdio: ["ignore", "pipe", "inherit"] });
try {
  const lines = createInterface({ input: gateway.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    once(gateway, "exit").then(() => { throw new Error("Gateway exited before readiness"); }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error("Gateway readiness timed out")), 10000).unref(); }),
  ]);
  lines.close();
  const origin = new URL(line.match(/http:\/\/\S+/)[0]).origin;
  const path = "/cdn-cgi/local/r2/s3/bucket/object?response-content-type=text%2Fplain";
  const { stdout: body } = await exec("docker", ["run", "--rm", "busybox:1.37.0", "wget", "-qO-", `${origin}${path}`]);
  assert.equal(body, `upstream:${path}`);
  assert.equal((await fetch(`${origin}/admin`)).status, 404);
  console.log("R2 gateway reachable from inner containers; signed path preserved; non-S3 route denied.");
} finally {
  gateway.kill("SIGTERM");
  await once(gateway, "exit");
  upstream.close();
}
NODE
if docker inspect meltiply-inner-proof >/dev/null 2>&1; then echo 'Inner container leaked to outer daemon' >&2; exit 1; fi
if docker image inspect meltiply-inner-proof:local >/dev/null 2>&1; then echo 'Inner image leaked to outer daemon' >&2; exit 1; fi
docker restart "$container" >/dev/null
docker exec "$container" bash /opt/meltiply-devcontainer/docker-init.sh
wait_for_docker
docker exec "$container" bash -euc '
  test "$(docker run --rm meltiply-inner-proof:local)" = nested-docker-works
  test "$(docker inspect --format "{{.State.Running}}" meltiply-inner-proof)" = false
'
printf 'Devcontainer DinD isolation, build, resource limits, Compose, listener, and restart smoke passed.\n'
