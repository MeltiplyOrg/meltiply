#!/usr/bin/env bash
# Hermetic regression test for the development launcher. A backend failure must
# stop the app, public site, and quick-tunnel sessions so make dev cannot leave a
# pending frontend running against an unavailable API, and the published tunnel
# hostname must be wired into every shared origin before the services boot.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
first_launcher=""
second_launcher=""
unrelated_pid=""

# Reaps replacement supervisors and the unrelated sentinel on every exit,
# including failed assertions and interrupts, before deleting their fixture.
# Supervisors retain their EXIT traps so their owned service groups also stop.
cleanup_fixture() {
  local pid
  for pid in "$first_launcher" "$second_launcher" "$unrelated_pid"; do
    [[ -z "$pid" ]] || kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "$first_launcher" "$second_launcher" "$unrelated_pid"; do
    [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true
  done
  rm -rf "$fixture"
}
trap cleanup_fixture EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

real_node="$(command -v node)"

# The "connector is not installed" scenario can only be observed when no real
# cloudflared is reachable. The devcontainer installs one system-wide, so PATH
# alone cannot simulate absence; runs below pin MELTIPLY_CLOUDFLARED_BIN to
# the fixture stub (or a nonexistent path) to control resolution hermetically.
# User-level bin dirs are still dropped so a stray user install cannot shadow.
sanitized_path=""
IFS=':' read -r -a path_entries <<<"$PATH"
for entry in "${path_entries[@]}"; do
  case "$entry" in
    "$HOME/.local/bin" | "$HOME/bin") continue ;;
  esac
  sanitized_path="${sanitized_path:+$sanitized_path:}$entry"
done
export LAUNCHER_PATH="$fixture/bin:$sanitized_path"
# resolve_cloudflared() honors the bin override before PATH, so pinning it at
# the fixture stub keeps cloudflared hermetic even when the host image has a
# real binary; runs that need "connector missing" point it at a path that
# does not exist.
export MELTIPLY_CLOUDFLARED_BIN="$fixture/bin/cloudflared"
# The connector stub records every invocation so the named-mode run can prove
# which cloudflared subcommands the launcher used.
export COMMAND_LOG="$fixture/commands.log"
# `cloudflared tunnel login` writes cert.pem; named_tunnel_ready refuses to use a
# named tunnel without it, so the fixture supplies one. It must be non-empty:
# the check tests for size, matching a real certificate.
printf 'fixture certificate material\n' >"$fixture/cert.pem"
export TUNNEL_ORIGIN_CERT="$fixture/cert.pem"

mkdir -p \
  "$fixture/bin" \
  "$fixture/frontend/app" \
  "$fixture/frontend/public" \
  "$fixture/scripts/cloudflare-local"
cp "$repo_root/scripts/cloudflare-local/dev.sh" \
  "$fixture/scripts/cloudflare-local/dev.sh"
cp "$repo_root/scripts/cloudflare-local/dev-tunnel.sh" \
  "$fixture/scripts/cloudflare-local/dev-tunnel.sh"
cp "$repo_root/scripts/cloudflare-local/quick-tunnel-url.mjs" \
  "$fixture/scripts/cloudflare-local/quick-tunnel-url.mjs"
cp "$repo_root/scripts/cloudflare-local/frontend-api-origin.sh" \
  "$fixture/scripts/cloudflare-local/frontend-api-origin.sh"
cp "$repo_root/scripts/cloudflare-local/tunnel-config.sh" \
  "$fixture/scripts/cloudflare-local/tunnel-config.sh"
cp "$repo_root/scripts/cloudflare-local/tunnel-hostname.mjs" \
  "$fixture/scripts/cloudflare-local/tunnel-hostname.mjs"
chmod +x "$fixture/scripts/cloudflare-local/"*.sh

# The launcher checks the committed frontend Wrangler config for API_ORIGIN, so
# the fixture supplies one matching the API port the runs below request.
cat >"$fixture/frontend/app/wrangler.jsonc" <<'EOF'
{
  "name": "meltiply-frontend",
  "vars": {
    // Local-only fallback origin for /api/* proxying.
    "API_ORIGIN": "http://127.0.0.1:9911",
  },
}
EOF

# A root .env shaped like the one `make setup` generates for the keys this
# change owns: the origin placeholders are empty and MELTIPLY_DEV_TUNNEL is
# present, so the launcher must still honour the caller's explicit choice over
# the file. Port keys are omitted because the root .env is authoritative for
# those; the runs below pass them on the command line instead.
cat >"$fixture/.env" <<'EOF'
ALLOWED_ORIGINS=
FRONTEND_URL=
PUBLIC_SITE_URL=
PUBLIC_API_URL=
API_BASE_URL=
MELTIPLY_DEV_TUNNEL=1
TUNNEL_TRANSPORT_PROTOCOL=auto
EOF

# The real node is needed for quick-tunnel-url.mjs; every other invocation is a
# stub that resolves the development host to loopback.
#
# Three call shapes reach this stub:
#   * tunnel-url/hostname scripts -> the real node, so the real logic is tested
#   * the inline JSON parser that checks whether a tunnel exists -> real node,
#     because it only reads stdin and touches no network
#   * the inline DNS resolution check -> driven by FIXTURE_DNS_OK, so both the
#     resolvable and unresolvable paths are reachable
cat >"$fixture/bin/node" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *quick-tunnel-url.mjs || "\${1:-}" == *tunnel-hostname.mjs ]]; then
  exec "$real_node" "\$@"
fi
if [[ "\${1:-}" == "-e" ]]; then
  if grep -q 'resolve4' <<<"\${2:-}"; then
    [[ "\${FIXTURE_DNS_OK:-1}" == "1" ]] && exit 0
    exit 1
  fi
  exec "$real_node" "\$@"
fi
printf '127.0.0.1\n'
EOF

# A connector that announces a deterministic hostname per published port, so the
# test can assert the app and public tunnels stay distinct.
# A connector stub covering both tunnel modes. `tunnel list` reports the named
# tunnel only when FIXTURE_TUNNEL_EXISTS is set, which is how the named-mode
# runs are switched on; the quick-tunnel branch announces a deterministic
# hostname per published port so the test can assert the two stay distinct.
cat >"$fixture/bin/cloudflared" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cloudflared %s\n' "$*" >>"${COMMAND_LOG:?}"
printf 'transport=%s\n' "${TUNNEL_TRANSPORT_PROTOCOL:-auto}" >>"${COMMAND_LOG:?}"

case "$*" in
  *tunnel\ list*)
    if [[ "${FIXTURE_TUNNEL_EXISTS:-0}" == "1" ]]; then
      printf '[{"id":"11111111-2222-3333-4444-555555555555","name":"%s"}]\n' \
        "${MELTIPLY_TUNNEL_NAME:-meltiply-dev}"
    else
      printf '[]\n'
    fi
    exit 0
    ;;
  *tunnel\ ingress\ validate*)
    # Reject a config with no catch-all, the way cloudflared does.
    if grep -q 'http_status:404' "$2"; then
      printf 'OK\n'
      exit 0
    fi
    printf 'catch-all rule is required\n' >&2
    exit 1
    ;;
  *tunnel\ ingress\ rule*)
    exit 0
    ;;
  *tunnel\ create*|*tunnel\ route\ dns*)
    printf 'created\n'
    exit 0
    ;;
esac

url=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--url" ]]; then
    url=$argument
  fi
  previous=$argument
done
if [[ -n "$url" ]]; then
  printf 'INF Requesting new quick Tunnel on trycloudflare.com...\n'
  printf 'INF |  https://fixture-%s.trycloudflare.com  |\n' "${url##*:}"
else
  printf 'INF Starting named tunnel\n'
fi
printf 'connector online\n'
trap 'exit 0' TERM
while :; do
  sleep 1
done
EOF

# A curl stub keeps the launcher's post-start tunnel probe hermetic: the fixture
# hostnames are not resolvable, so a real curl would retry for two minutes.
cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  case "$argument" in
    https://fixture-*.trycloudflare.com/* | https://dev-tunnel.meltiply.com/*)
      printf '200'
      exit 0
      ;;
  esac
done
exit 7
EOF

# Records the environment each service was launched with so the test can assert
# the tunnel-derived origins reached wrangler and Vite.
cat >"$fixture/scripts/cloudflare-local/dev-backend.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'backend WRANGLER_DEV_ALLOWED_ORIGINS=%s\n' "${WRANGLER_DEV_ALLOWED_ORIGINS:-}"
  printf 'backend WRANGLER_DEV_FRONTEND_URL=%s\n' "${WRANGLER_DEV_FRONTEND_URL:-}"
  printf 'backend WRANGLER_DEV_PUBLIC_API_URL=%s\n' "${WRANGLER_DEV_PUBLIC_API_URL:-}"
} >"$MELTIPLY_DEV_FIXTURE/backend.env"
for service in frontend public; do
  for _ in $(seq 1 200); do
    [[ -e "$MELTIPLY_DEV_FIXTURE/$service.started" ]] && break
    sleep 0.01
  done
  [[ -e "$MELTIPLY_DEV_FIXTURE/$service.started" ]]
done
exit 17
EOF

cat >"$fixture/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Both workspaces expose a dev script; unavailable raw CLI names must fail
# here just as they do with the installed toolchain.
if [[ "${1:-} ${2:-} ${3:-}" != "run --no-install dev" ]]; then
  printf 'workspace dev script required: %s\n' "$*" >&2
  exit 2
fi
case "$PWD" in
  "$MELTIPLY_DEV_FIXTURE/frontend/app")
    service=frontend
    printf 'frontend API_BASE_URL=%s\n' "${API_BASE_URL:-}" \
      >>"$MELTIPLY_DEV_FIXTURE/frontend.env"
    printf 'frontend FRONTEND_URL=%s\n' "${FRONTEND_URL:-}" \
      >>"$MELTIPLY_DEV_FIXTURE/frontend.env"
    printf 'frontend FRONTEND_DEV_HOST=%s\n' "${FRONTEND_DEV_HOST:-}" \
      >>"$MELTIPLY_DEV_FIXTURE/frontend.env"
    ;;
  "$MELTIPLY_DEV_FIXTURE/frontend/public")
    service=public
    printf 'public PUBLIC_SITE_URL=%s\n' "${PUBLIC_SITE_URL:-}" \
      >>"$MELTIPLY_DEV_FIXTURE/frontend.env"
    ;;
  *)
    printf 'unexpected fake bun invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
touch "$MELTIPLY_DEV_FIXTURE/$service.started"
printf '%s\n' "$$" >"$MELTIPLY_DEV_FIXTURE/$service.pid"
trap 'exit 0' TERM
while :; do
  sleep 1
done
EOF
chmod +x \
  "$fixture/bin/node" \
  "$fixture/bin/bun" \
  "$fixture/bin/cloudflared" \
  "$fixture/bin/curl" \
  "$fixture/scripts/cloudflare-local/dev-backend.sh"

# fail asserts a condition, printing every captured launcher log to explain a
# failure. Any run's log may be the relevant one, so dump them all.
fail() {
  printf '%s\n' "$1" >&2
  local captured
  for captured in "$fixture"/dev-*.log; do
    [[ -f "$captured" ]] || continue
    printf -- '--- %s ---\n' "$(basename "$captured")" >&2
    cat "$captured" >&2 2>/dev/null || true
  done
  exit 1
}

expect_contains() {
  local file=$1 needle=$2 label=$3
  [[ -f "$file" ]] || fail "$label: $file was never written"
  grep -Fq "$needle" "$file" || fail "$label: $file does not contain '$needle'"
}

# Clears everything a previous run leaves behind so each scenario is observed
# from a cold start rather than inheriting earlier markers.
reset_run_state() {
  rm -rf "$fixture/.wrangler"
  rm -f "$fixture"/*.started "$fixture"/*.pid \
    "$fixture/frontend.env" "$fixture/backend.env"
}

# --- run 1: quick tunnel is the default ---------------------------------------
# Quick Tunnels are the default because Cloudflare deletes them automatically.
# Nothing may be provisioned in a Cloudflare account during a default run.
log_file="$fixture/dev.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 \
    FRONTEND_DEV_PORT=9912 \
    PUBLIC_SITE_DEV_PORT=9913 \
    MELTIPLY_DEV_TUNNEL_MODE=quick \
    TUNNEL_TRANSPORT_PROTOCOL=http2 \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "17" ]] || fail "expected backend exit status 17, got $status"

app_tunnel="https://fixture-9912.trycloudflare.com"
public_tunnel="https://fixture-9913.trycloudflare.com"

# The launcher must report both hostnames and the local origins it kept serving.
expect_contains "$log_file" "$app_tunnel" app-url-summary
expect_contains "$log_file" "$public_tunnel" public-url-summary
expect_contains "$COMMAND_LOG" "transport=http2" quick-container-transport
if grep -q 'transport=auto' "$COMMAND_LOG"; then
  fail "root .env overwrote the container's Quick Tunnel transport"
fi
expect_contains "$log_file" "app=http://127.0.0.1:9912" local-app-origin
expect_contains "$log_file" "api=http://127.0.0.1:9911" local-api-origin

# The launcher must not write a .dev.vars override: Wrangler folds that file
# into `wrangler types`, so its presence would make the committed
# cloudflare-env.d.ts drift and fail `cf-typegen:check`. A port mismatch is
# reported instead (see run 6).
[[ ! -e "$fixture/frontend/app/.dev.vars" ]] ||
  fail "dev.sh must not write frontend/app/.dev.vars"

# The default Quick Tunnel must leave no Cloudflare-side state behind. Anything
# the account keeps (a tunnel, a DNS record) outlives the container and nothing
# here would ever clean it up, so provisioning must be opt-in.
if grep -qE 'tunnel (create|route dns)' "$COMMAND_LOG"; then
  fail "the default quick-tunnel run provisioned account resources"
fi
if [[ -f "$fixture/.dev-tunnel/config.yml" ]]; then
  fail "the default quick-tunnel run wrote a named-tunnel config"
fi
expect_contains "$log_file" "deletes this tunnel and its DNS record" cleanup-promise

# Vite receives the tunnel origin as both canonical host and API base, which is
# what puts the tunnel hostname on the server's allowedHosts list.
expect_contains "$fixture/frontend.env" \
  "frontend API_BASE_URL=$app_tunnel" vite-api-base
expect_contains "$fixture/frontend.env" \
  "frontend FRONTEND_URL=$app_tunnel" vite-canonical-origin
expect_contains "$fixture/frontend.env" \
  "public PUBLIC_SITE_URL=$public_tunnel" astro-canonical-origin

# The Worker must authorize the tunnel origin, and keep the local one working.
expect_contains "$fixture/backend.env" \
  "backend WRANGLER_DEV_ALLOWED_ORIGINS=http://127.0.0.1:9912,$app_tunnel" \
  worker-allowed-origins
expect_contains "$fixture/backend.env" \
  "backend WRANGLER_DEV_FRONTEND_URL=$app_tunnel" worker-frontend-url
expect_contains "$fixture/backend.env" \
  "backend WRANGLER_DEV_PUBLIC_API_URL=$app_tunnel" worker-public-api-url

# Every session this run owns, tunnels included, must be gone afterwards.
for service in frontend public; do
  [[ -e "$fixture/$service.started" ]] || fail "$service did not start"
  pid="$(<"$fixture/$service.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    fail "$service process $pid survived backend failure"
  fi
done
if pgrep -f "$fixture/bin/cloudflared" >/dev/null 2>&1; then
  fail "a quick tunnel survived backend failure"
fi
# The public tunnel and app tunnel are separate connectors, so both logs exist.
[[ -s "$fixture/.wrangler/logs/quick-tunnel-app.log" ]] || fail "app tunnel log missing"
[[ -s "$fixture/.wrangler/logs/quick-tunnel-public.log" ]] ||
  fail "public tunnel log missing"

# --- run 2: named tunnel is opt-in and provisioned for this branch -----------
# Each branch gets its own tunnel and its own explicit DNS records. Nothing is
# discovered: the origins must be wired before the connector starts, and the
# ingress rules must carry the ports the stack actually bound.
reset_run_state
: >"$COMMAND_LOG"
export FIXTURE_TUNNEL_EXISTS=0
log_file="$fixture/dev-named.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 \
    FRONTEND_DEV_PORT=9912 \
    PUBLIC_SITE_DEV_PORT=9913 \
    MELTIPLY_DEV_TUNNEL_MODE=named \
    MELTIPLY_TUNNEL_DOMAIN=meltiply.com \
    TUNNEL_TRANSPORT_PROTOCOL=http2 \
    MELTIPLY_TUNNEL_BRANCH=dev-tunnel \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "17" ]] || fail "expected backend exit 17 in named mode, got $status"
# Opting in must state the cost: nothing here will ever delete it again.
expect_contains "$log_file" "opts out of Cloudflare's automatic cleanup" named-leak-warning

expect_contains "$log_file" "Using this branch's named Cloudflare Tunnel" named-mode-notice
expect_contains "$log_file" "Tunnel live: app and API reachable" named-health-probe
expect_contains "$COMMAND_LOG" "transport=http2" named-container-transport
if grep -q 'transport=auto' "$COMMAND_LOG"; then
  fail "root .env overwrote the container's named tunnel transport"
fi
# A tunnel that does not exist yet must be created, not treated as a failure.
expect_contains "$log_file" "Creating tunnel meltiply-dev-dev-tunnel" tunnel-created
expect_contains "$log_file" "app + api  https://dev-tunnel.meltiply.com" named-app-url
# Quick tunnels must be skipped entirely once a named tunnel is usable.
expect_contains "$fixture/frontend.env" \
  "frontend API_BASE_URL=https://dev-tunnel.meltiply.com" named-api-base
expect_contains "$fixture/backend.env" \
  "backend WRANGLER_DEV_ALLOWED_ORIGINS=http://127.0.0.1:9912,https://dev-tunnel.meltiply.com" \
  named-allowed-origins
if grep -q 'trycloudflare' "$COMMAND_LOG"; then
  fail "named mode still launched a quick tunnel"
fi

# The tunnel must be created and both hostnames routed to it.
expect_contains "$COMMAND_LOG" "tunnel create meltiply-dev-dev-tunnel" tunnel-create-argv
expect_contains "$COMMAND_LOG" \
  "tunnel route dns meltiply-dev-dev-tunnel dev-tunnel.meltiply.com" route-app
expect_contains "$COMMAND_LOG" \
  "tunnel route dns meltiply-dev-dev-tunnel dev-tunnel-public.meltiply.com" route-public
# A wildcard record would capture every branch, so it must never be created here.
if grep -q 'route dns.*\*' "$COMMAND_LOG"; then
  fail "a per-branch tunnel must not create a wildcard DNS record"
fi

# The generated ingress rules must carry the bound ports, name the branch's own
# tunnel, and end in the catch-all.
config="$fixture/.dev-tunnel/config.yml"
[[ -f "$config" ]] || fail "named mode did not write a tunnel config"
expect_contains "$config" "tunnel: 'meltiply-dev-dev-tunnel'" ingress-tunnel-name
expect_contains "$config" "http://127.0.0.1:9912" ingress-app-port
expect_contains "$config" "http://127.0.0.1:9913" ingress-public-port
expect_contains "$config" "http_status:404" ingress-catchall
if grep -q "'\*\.dev" "$config"; then
  fail "a per-branch tunnel must not use a wildcard ingress rule"
fi
# The public rule must precede the app rule or nothing else could match it.
public_line="$(grep -n "dev-tunnel-public.meltiply.com" "$config" | cut -d: -f1)"
app_line="$(grep -n "'dev-tunnel.meltiply.com'" "$config" | cut -d: -f1)"
[[ "$public_line" -lt "$app_line" ]] ||
  fail "the public ingress rule must precede the app rule"

# --- run 3: opt out (no tunnel published) ------------------------------------
reset_run_state
log_file="$fixture/dev-nolunnel.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 \
    FRONTEND_DEV_PORT=9912 \
    PUBLIC_SITE_DEV_PORT=9913 \
    MELTIPLY_DEV_TUNNEL=0 \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "17" ]] || fail "expected backend exit 17 with tunnel disabled, got $status"
expect_contains "$log_file" "Dev tunnel disabled" opt-out-notice
# Local origins must survive untouched when no tunnel is published.
expect_contains "$fixture/frontend.env" \
  "frontend API_BASE_URL=http://127.0.0.1:9911" local-api-base
expect_contains "$fixture/backend.env" \
  "backend WRANGLER_DEV_ALLOWED_ORIGINS=http://127.0.0.1:9912" local-allowed-origins

# --- run 4: quick connector installed but unable to publish ------------------
# A connector that dies before printing a URL must fail the run loudly instead
# of silently degrading to a local-only stack the developer believes is public.
cat >"$fixture/bin/cloudflared" <<'EOF'
#!/usr/bin/env bash
printf 'ERR failed to request quick Tunnel: connection refused\n' >&2
exit 1
EOF
chmod +x "$fixture/bin/cloudflared"
reset_run_state
log_file="$fixture/dev-failed.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 \
    FRONTEND_DEV_PORT=9912 \
    MELTIPLY_DEV_TUNNEL_MODE=quick \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "1" ]] || fail "expected exit 1 when the tunnel cannot publish, got $status"
expect_contains "$log_file" "Could not publish a quick tunnel" tunnel-failure
expect_contains "$log_file" "MELTIPLY_DEV_TUNNEL=0 make dev" opt-out-hint
[[ ! -e "$fixture/frontend.started" ]] ||
  fail "services booted even though the tunnel could not be published"

# --- run 5: connector missing falls back to local-only ------------------------
export MELTIPLY_CLOUDFLARED_BIN="$fixture/bin/no-cloudflared"
reset_run_state
log_file="$fixture/dev-missing.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 \
    FRONTEND_DEV_PORT=9912 \
    MELTIPLY_DEV_TUNNEL_MODE=quick \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "17" ]] || fail "expected backend exit 17 without a connector, got $status"
expect_contains "$log_file" "cloudflared is not installed" install-hint
expect_contains "$log_file" "serving local origins only" local-only-notice

# --- run 6: frontend proxy port disagrees with the API port -------------------
# The API Worker would answer while every browser API call 502s through the
# frontend proxy, so the launcher must refuse to boot and say why.
reset_run_state
log_file="$fixture/dev-port-mismatch.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9921 \
    FRONTEND_DEV_PORT=9912 \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "1" ]] || fail "expected exit 1 on API port mismatch, got $status"
expect_contains "$log_file" "proxies /api/* to port 9911" proxy-port-reported
expect_contains "$log_file" "bound the API Worker to port 9921" api-port-reported
# A mismatch must be caught before any tunnel is published or service started.
[[ ! -d "$fixture/.wrangler" ]] || fail "a tunnel was published despite the port mismatch"
[[ ! -e "$fixture/frontend.started" ]] || fail "services booted despite the port mismatch"

# --- run 7: DNS record accepted but hostname never resolves -------------------
# `tunnel route dns` exits 0 even when the record lands in a Cloudflare account
# other than the one serving the zone, so the launcher must trust resolution
# rather than the CLI's exit status and refuse to start.
cat >"$fixture/bin/cloudflared" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cloudflared %s\n' "$*" >>"${COMMAND_LOG:?}"
case "$*" in
  *tunnel\ list*) printf '[{"id":"abc","name":"meltiply-dev-dev-tunnel"}]\n' ;;
  *tunnel\ route\ dns*) printf 'INF Added CNAME which will route to this tunnel\n' ;;
  *tunnel\ ingress\ validate*) printf 'OK\n' ;;
  *) exit 0 ;;
esac
exit 0
EOF
chmod +x "$fixture/bin/cloudflared"
export MELTIPLY_CLOUDFLARED_BIN="$fixture/bin/cloudflared"
# The connector reports success for everything, exactly as it does when a record
# lands in the wrong Cloudflare account. Only the DNS check can catch that.
export FIXTURE_DNS_OK=0
reset_run_state
: >"$COMMAND_LOG"
log_file="$fixture/dev-dns-missing.log"
set +e
(
  cd "$fixture"
  PATH="$LAUNCHER_PATH" \
    BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 \
    FRONTEND_DEV_PORT=9912 \
    MELTIPLY_DEV_TUNNEL_MODE=named \
    MELTIPLY_TUNNEL_BRANCH=dev-tunnel \
    MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh" >"$log_file" 2>&1
)
status=$?
set -e
[[ "$status" == "1" ]] || fail "expected exit 1 when the hostname does not resolve, got $status"
expect_contains "$log_file" "does not" dns-not-resolving
expect_contains "$log_file" "cloudflared tunnel login" dns-remedy
expect_contains "$log_file" "propagate" dns-propagation-hint
# A dead public URL is worse than no tunnel: nothing may boot.
[[ ! -e "$fixture/frontend.started" ]] || fail "services booted with an unresolvable tunnel"
[[ ! -d "$fixture/.wrangler/logs/named-tunnel.log" ]] ||
  fail "the connector was started despite the hostname not resolving"

# --- run 8: a second launch replaces only this checkout's running stack -------
# Keep the backend alive so replacement, rather than a service failure, ends
# the first run. Real process groups exercise the launcher's shutdown boundary.
reset_run_state
cat >"$fixture/scripts/cloudflare-local/dev-backend.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$MELTIPLY_DEV_FIXTURE/backend.pid"
trap 'exit 0' TERM
while :; do sleep 0.1; done
EOF

# Launches the fixture stack without network access; services remain real
# process groups so replacing a run must terminate all its descendants.
launch_replacement_fixture() {
  exec env PATH="$LAUNCHER_PATH" BUN="$fixture/bin/bun" \
    WRANGLER_DEV_PORT=9911 FRONTEND_DEV_PORT=9912 \
    PUBLIC_SITE_DEV_PORT=9913 \
    MELTIPLY_DEV_TUNNEL=0 MELTIPLY_DEV_FIXTURE="$fixture" \
    "$fixture/scripts/cloudflare-local/dev.sh"
}

# Waits for all three services to publish their PIDs, bounding startup failures
# instead of leaving the lifecycle regression hanging indefinitely.
wait_for_stack() {
  for _ in $(seq 1 200); do
    if [[ -s "$fixture/backend.pid" && -s "$fixture/frontend.pid" &&
      -s "$fixture/public.pid" ]]; then
      return 0
    fi
    sleep 0.05
  done
  fail "replacement stack did not start"
}

sleep 60 &
unrelated_pid=$!
mkdir -p "$fixture/.wrangler"
printf '%s\n' "$unrelated_pid" >"$fixture/.wrangler/dev.pid"
launch_replacement_fixture >"$fixture/dev-replace-first.log" 2>&1 &
first_launcher=$!
wait_for_stack
old_services=()
for service in backend frontend public; do
  read -r pid <"$fixture/$service.pid"
  old_services+=("$pid")
done
rm -f "$fixture"/{backend,frontend,public}.pid
launch_replacement_fixture >"$fixture/dev-replace-second.log" 2>&1 &
second_launcher=$!
wait_for_stack
set +e
wait "$first_launcher"
status=$?
set -e
first_launcher=""
[[ "$status" == 143 ]] || fail "replaced launcher exited $status, expected 143"
for pid in "${old_services[@]}"; do
  ! kill -0 "$pid" 2>/dev/null || fail "replacement left old service $pid alive"
done
kill -0 "$unrelated_pid" || fail "replacement killed an unrelated stale PID"
read -r active_launcher <"$fixture/.wrangler/dev.pid"
kill -TERM "$active_launcher"
set +e
wait "$second_launcher"
status=$?
set -e
second_launcher=""
[[ "$status" == 143 ]] || fail "replacement shutdown exited $status, expected 143"
for service in backend frontend public; do
  read -r pid <"$fixture/$service.pid"
  ! kill -0 "$pid" 2>/dev/null || fail "shutdown left replacement service $pid alive"
done
kill -TERM "$unrelated_pid"
wait "$unrelated_pid" 2>/dev/null || true
unrelated_pid=""

printf 'cloudflare local development lifecycle tests passed\n'
