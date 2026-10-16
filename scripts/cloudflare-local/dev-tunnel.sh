#!/usr/bin/env bash
# Cloudflare Quick Tunnel helper for `make dev`.
#
# Quick Tunnels need no Cloudflare account: `cloudflared` dials the edge, is
# assigned a random `https://<words>.trycloudflare.com` hostname, and forwards
# every request to a single local origin. This script owns the two operations
# the dev launcher needs and nothing else, so the tunnel flags live in exactly
# one place.
#
#   dev-tunnel.sh binary            print the resolved cloudflared path
#   dev-tunnel.sh run <port>        publish 127.0.0.1:<port> on a random hostname
#   dev-tunnel.sh run-named <cfg> <name>
#                                   publish the hostnames in a named tunnel's
#                                   ingress configuration
#   dev-tunnel.sh named-possible   exit 0 when a named tunnel can be provisioned
#   dev-tunnel.sh setup             create the tunnel and its DNS records once
#
# `run` and `run-named` exec the connector so the caller's process group leader
# *is* cloudflared; that is what lets `dev.sh` reap the tunnel with its existing
# group teardown.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Resolves cloudflared from the explicit override first, then PATH. Both
# MELTIPLY_CLOUDFLARED_BIN (repository convention) and CLOUDFLARED_BIN (the
# upstream variable) are honored. An override that names a path but is not
# executable is authoritative: the function fails rather than silently falling
# through to a PATH binary the operator did not choose. A bare-name override
# resolves through PATH like the default lookup.
#
# @return 0 and print the executable path; return 1 when cloudflared is absent
#   or a configured path override cannot be executed.
resolve_cloudflared() {
  local candidate resolved
  # An explicit override is authoritative: a configured path that is not
  # executable is a misconfiguration, not a hint to keep searching PATH.
  for candidate in "${MELTIPLY_CLOUDFLARED_BIN:-}" "${CLOUDFLARED_BIN:-}"; do
    [[ -n "$candidate" ]] || continue
    if [[ "$candidate" != */* ]]; then
      # A bare name behaves like the default PATH lookup below.
      if resolved="$(command -v "$candidate" 2>/dev/null)"; then
        printf '%s\n' "$resolved"
        return 0
      fi
      continue
    fi
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    return 1
  done
  # Default resolution: cloudflared from PATH.
  if resolved="$(command -v cloudflared 2>/dev/null)"; then
    printf '%s\n' "$resolved"
    return 0
  fi
  return 1
}

# Prints the connector path, or an actionable install hint on stderr. Callers
# use the non-zero status to fall back to local-only development.
print_binary() {
  local resolved
  if resolved="$(resolve_cloudflared)"; then
    printf '%s\n' "$resolved"
    return 0
  fi
  cat >&2 <<'HINT'
cloudflared is not installed, so `make dev` cannot publish a public tunnel.
Install it with one of:
  macOS:        brew install cloudflared
  Debian/Ubuntu: curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
                  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
                echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
                  https://pkg.cloudflare.com/cloudflared any main" \
                  | sudo tee /etc/apt/sources.list.d/cloudflared.list
                sudo apt-get update && sudo apt-get install cloudflared
  or point MELTIPLY_CLOUDFLARED_BIN at an existing binary.
See https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/
HINT
  return 1
}

# Publishes a loopback port on a random hostname. The URL is announced on stderr
# by cloudflared itself; `dev.sh` reads it back through quick-tunnel-url.mjs.
#
# @param $1 Loopback TCP port to expose, normally the frontend or public port.
run_quick_tunnel() {
  local port=$1 cloudflared
  if ! cloudflared="$(resolve_cloudflared)"; then
    print_binary >/dev/null
    return 1
  fi
  # --no-autoupdate keeps a quick tunnel from rewriting itself mid-session and
  # from silently changing version between two local runs.
  exec "$cloudflared" tunnel --no-autoupdate --url "http://127.0.0.1:$port"
}

# Publishes a loopback port on the stable hostnames declared in a named
# tunnel's ingress configuration.
#
# @param $1 Path to the generated config.yml.
# @param $2 Tunnel name as written in that configuration.
run_named_tunnel() {
  local config=$1 name=$2 cloudflared
  if ! cloudflared="$(resolve_cloudflared)"; then
    print_binary >/dev/null
    return 1
  fi
  exec "$cloudflared" --config "$config" --no-autoupdate tunnel run "$name"
}
# The tunnel name for this branch. A shared tunnel keeps one name; by default
# each branch gets its own tunnel, named after the branch, so branches are
# isolated from each other in the Cloudflare dashboard.
tunnel_name() {
  if [[ "${MELTIPLY_TUNNEL_SHARED:-0}" == "1" ]]; then
    printf '%s\n' "${MELTIPLY_TUNNEL_NAME:-meltiply-dev}"
    return 0
  fi
  node "$repo_root/scripts/cloudflare-local/tunnel-hostname.mjs" --tunnel-name
}

# Reports whether a named tunnel can be created and run for this branch. The
# connector and the account authorization are both required; the tunnel itself
# need not exist yet, because `make dev` provisions it on demand.
#
# @return 0 when `setup_named_tunnel` followed by `run_named_tunnel` can succeed.
named_tunnel_possible() {
  local cloudflared
  cloudflared="$(resolve_cloudflared)" || return 1
  # cert.pem is what `tunnel login` writes and what authorizes creating the
  # tunnel and its DNS records.
  [[ -s "${TUNNEL_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}" ]] || return 1
}

# Reads the API token and zone id out of the cert.pem that `tunnel login`
# wrote, so replacing a stale DNS record needs no separate API token.
# Exports MELTIPLY_TUNNEL_API_TOKEN and MELTIPLY_TUNNEL_ZONE_ID; a missing or
# unreadable file simply leaves them empty, which disables only the
# stale-record replacement, not the rest of provisioning.
load_tunnel_api_credentials() {
  local cert="${TUNNEL_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}"
  [[ -s "$cert" ]] || return 0
  local decoded
  decoded="$(node -e '
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(process.argv[1], "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("-----"))
      .join("");
    const json = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8"),
    );
    process.stdout.write(`${json.apiToken ?? ""} ${json.zoneID ?? ""}`);
  ' "$cert" 2>/dev/null)" || return 0
  MELTIPLY_TUNNEL_API_TOKEN="${decoded%% *}"
  MELTIPLY_TUNNEL_ZONE_ID="${decoded##* }"
  export MELTIPLY_TUNNEL_API_TOKEN MELTIPLY_TUNNEL_ZONE_ID
}

# Prints the UUID of an existing tunnel.
#
# @param $1 Resolved cloudflared path.
# @param $2 Tunnel name.
tunnel_uuid() {
  local cloudflared=$1 name=$2
  "$cloudflared" tunnel list --output json 2>/dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          const found = JSON.parse(raw).find(
            (tunnel) => tunnel?.name === process.argv[1],
          );
          if (found?.id) process.stdout.write(`${found.id}\n`);
        } catch {
          // Leave stdout empty; the caller reports the routing failure.
        }
      });
    ' "$name"
}

# Points one hostname at this tunnel, replacing a record left behind by an
# earlier tunnel.
#
# Deleting a Cloudflare tunnel does NOT delete its DNS records, so a hostname
# can be left pointing at a tunnel that no longer exists. `tunnel route dns`
# then refuses with "record with that host already exists", which would make
# every recreated branch permanently unreachable. Detecting the stale target and
# replacing it is what makes provisioning survive a container being recreated.
#
# @param $1 Resolved cloudflared path.
# @param $2 Tunnel name.
# @param $3 Tunnel UUID.
# @param $4 Hostname to route.
# @return 0 when the hostname resolves to this tunnel.
route_hostname() {
  local cloudflared=$1 name=$2 tunnel_id=$3 hostname=$4 output
  if output="$("$cloudflared" tunnel route dns "$name" "$hostname" 2>&1)"; then
    printf '  routed %s\n' "$hostname"
    return 0
  fi
  if grep -q 'already configured' <<<"$output"; then
    printf '  %s already routed\n' "$hostname"
    return 0
  fi
  if ! grep -q 'already exists' <<<"$output"; then
    printf '  failed to route %s:\n' "$hostname" >&2
    sed 's/^/    /' <<<"$output" >&2
    return 1
  fi

  # The record exists. If it already targets this tunnel there is nothing to do;
  # otherwise it is a leftover and must be replaced.
  local current
  current="$(record_target "$hostname")"
  if [[ "$current" == "$tunnel_id.cfargotunnel.com" ]]; then
    printf '  %s already points at this tunnel\n' "$hostname"
    return 0
  fi
  if [[ -z "$current" ]]; then
    printf '  failed to route %s:\n' "$hostname" >&2
    sed 's/^/    /' <<<"$output" >&2
    return 1
  fi

  printf '  replacing stale %s -> %s\n' "$hostname" "${current%%.*}"
  if ! delete_record "$hostname"; then
    printf '  failed to remove the stale record for %s\n' "$hostname" >&2
    return 1
  fi
  if output="$("$cloudflared" tunnel route dns "$name" "$hostname" 2>&1)"; then
    printf '  routed %s\n' "$hostname"
    return 0
  fi
  printf '  failed to route %s after replacing the stale record:\n' "$hostname" >&2
  sed 's/^/    /' <<<"$output" >&2
  return 1
}

# Prints the CNAME target currently published for a hostname, or empty.
#
# @param $1 Hostname.
record_target() {
  api_call GET "/zones/$MELTIPLY_TUNNEL_ZONE_ID/dns_records?name=$1" 2>/dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          const records = JSON.parse(raw).result ?? [];
          const cname = records.find((r) => r?.type === "CNAME");
          if (cname?.content) process.stdout.write(`${cname.content}\n`);
        } catch {
          // Leave stdout empty; the caller reports the failure.
        }
      });
    '
}

# Deletes the CNAME record published for a hostname.
#
# @param $1 Hostname.
# @return 0 when no record remains for the hostname.
delete_record() {
  local hostname=$1 record_id
  record_id="$(api_call GET "/zones/$MELTIPLY_TUNNEL_ZONE_ID/dns_records?name=$hostname" 2>/dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          const record = (JSON.parse(raw).result ?? []).find(
            (r) => r?.type === "CNAME",
          );
          if (record?.id) process.stdout.write(`${record.id}\n`);
        } catch {
          // Leave stdout empty; the caller reports the failure.
        }
      });
    ')"
  [[ -n "$record_id" ]] || return 0
  api_call DELETE "/zones/$MELTIPLY_TUNNEL_ZONE_ID/dns_records/$record_id" >/dev/null
}

# Calls the Cloudflare API with the credential `tunnel login` already wrote.
#
# @param $1 HTTP method.
# @param $2 API path.
# @returns The response body on stdout, or nothing on failure.
api_call() {
  local method=$1 path=$2
  [[ -n "${MELTIPLY_TUNNEL_API_TOKEN:-}" && -n "${MELTIPLY_TUNNEL_ZONE_ID:-}" ]] || return 0
  curl --silent --show-error --max-time 20 \
    --request "$method" \
    --header "Authorization: Bearer $MELTIPLY_TUNNEL_API_TOKEN" \
    "https://api.cloudflare.com/client/v4$path"
}

# @return 0 when a tunnel with the configured name is visible to this account.
cloudflared_tunnel_exists() {
  local cloudflared=$1 name
  name="$(tunnel_name)"
  # Parse the JSON rather than grepping it: `tunnel list --output json` is
  # pretty-printed, so a `"name":"x"` pattern never matches, and the tunnel is
  # then re-created on every run.
  "$cloudflared" tunnel list --output json 2>/dev/null |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          const tunnels = JSON.parse(raw);
          process.exit(
            Array.isArray(tunnels) &&
              tunnels.some((tunnel) => tunnel?.name === process.argv[1])
              ? 0
              : 1,
          );
        } catch {
          process.exit(1);
        }
      });
    ' "$name"
}

# Creates an explicitly configured domain's branch tunnel and DNS records,
# idempotently. Requires MELTIPLY_TUNNEL_DOMAIN; `make dev` calls this only in named mode.
#
# Per-branch tunnels are reached by explicit records: a wildcard CNAME has a
# single target, so it can only ever point at one tunnel and would capture every
# other branch. A wildcard is therefore only correct in shared-tunnel mode.
setup_named_tunnel() {
  local cloudflared name
  if ! cloudflared="$(resolve_cloudflared)"; then
    print_binary >&2
    return 1
  fi
  name="$(tunnel_name)"
  load_tunnel_api_credentials
  local app_hostname
  app_hostname="$("$repo_root/scripts/cloudflare-local/tunnel-config.sh" coverage app)"

  if [[ ! -s "${TUNNEL_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}" ]]; then
    cat >&2 <<LOGIN
cloudflared is installed but this account has not authorized it yet, so the
per-branch tunnel cannot be created. Run:  cloudflared tunnel login
It opens a browser, and the resulting $HOME/.cloudflared/cert.pem is what
authorizes creating the tunnel and its DNS records.
LOGIN
    return 1
  fi

  if cloudflared_tunnel_exists "$cloudflared"; then
    printf 'Tunnel %s already exists.\n' "$name"
  else
    printf 'Creating tunnel %s for this branch...\n' "$name"
    # A concurrent `make dev` for the same branch can win this race, and the
    # tunnel existing afterwards is the desired end state, so that outcome is
    # accepted too. Any other error is real and must surface.
    local create_output
    if create_output="$("$cloudflared" tunnel create "$name" 2>&1)"; then
      printf '%s\n' "$create_output"
    elif ! grep -q 'already exists' <<<"$create_output"; then
      printf '%s\n' "$create_output" >&2
      return 1
    fi
  fi

  # Deduplicate: shared-tunnel mode resolves both hosts to one record.
  local hostname seen='' routing_ok=0 tunnel_id
  tunnel_id="$(tunnel_uuid "$cloudflared" "$name")"
  for hostname in $("$repo_root/scripts/cloudflare-local/tunnel-config.sh" coverage app) \
    $("$repo_root/scripts/cloudflare-local/tunnel-config.sh" coverage public); do
    [[ "$hostname" == "$seen" ]] && continue
    seen="$hostname"
    if route_hostname "$cloudflared" "$name" "$tunnel_id" "$hostname"; then
      routing_ok=$((routing_ok + 1))
    fi
  done

  if ((routing_ok == 0)); then
    printf '\nNo DNS record was created for tunnel %s, so its hostname will not\n' \
      "$name" >&2
    printf 'resolve. `tunnel route dns` only writes records for zones in the\n' >&2
    printf 'Cloudflare account that cert.pem was issued for.\n' >&2
    printf '  Re-run `cloudflared tunnel login` in the account that owns %s.\n' \
      "${MELTIPLY_TUNNEL_DOMAIN:?Set MELTIPLY_TUNNEL_DOMAIN to a domain you own}" >&2
    return 1
  fi

  # `tunnel route dns` exits 0 without telling you whether the record reached
  # the zone, so confirm the hostname resolves before declaring success. A
  # freshly created CNAME can take a minute or two to propagate, which is not a
  # failure, so the wait is generous and the message names propagation as the
  # likeliest cause.
  if ! wait_for_dns "$app_hostname"; then
    printf '\nTunnel %s was created, but %s still does not resolve.\n' \
      "$name" "$app_hostname" >&2
    printf '  A new CNAME can take several minutes to propagate; if it resolves\n' >&2
    printf '  on a retry, nothing is wrong. If it never resolves, tunnel route\n' >&2
    printf '  dns wrote the record to a Cloudflare account other than the one\n' >&2
    printf '  serving %s. Re-run `cloudflared tunnel login` in the right\n' \
      "${MELTIPLY_TUNNEL_DOMAIN:?Set MELTIPLY_TUNNEL_DOMAIN to a domain you own}" >&2
    printf '  account, or use the default Quick Tunnel instead.\n' >&2
    return 1
  fi

  printf 'Tunnel %s is ready.\n' "$name"
}

# Waits for a hostname to resolve, so a misrouted record fails loudly instead of
# producing a tunnel whose URL never loads.
#
# @param $1 Hostname to resolve.
# @return 0 once it resolves, non-zero after the retry budget.
wait_for_dns() {
  local hostname=$1 attempt
  for attempt in $(seq 1 15); do
    if node -e '
      // Query public resolvers directly. The system resolver can hold a
      // negative cache entry for a hostname that has just been created, which
      // reports ENOTFOUND for a record that is live and serving.
      const resolver = new (require("node:dns").Resolver)();
      resolver.setServers(["1.1.1.1", "8.8.8.8"]);
      resolver.resolve4(process.argv[1], (error) =>
        process.exit(error ? 1 : 0),
      );
    ' "$hostname"; then
      return 0
    fi
    sleep 4
  done
  return 1
}

case "${1:-}" in
  binary)
    print_binary
    ;;
  run)
    [[ $# -eq 2 ]] || {
      printf 'usage: %s run <port>\n' "$0" >&2
      exit 2
    }
    run_quick_tunnel "$2"
    ;;
  run-named)
    [[ $# -eq 3 ]] || {
      printf 'usage: %s run-named <config> <tunnel-name>\n' "$0" >&2
      exit 2
    }
    run_named_tunnel "$2" "$3"
    ;;
  named-possible)
    named_tunnel_possible
    ;;
  setup)
    setup_named_tunnel
    ;;
  *)
    printf 'usage: %s {binary|run <port>|run-named <config> <name>|named-possible|setup}\n' \
      "$0" >&2
    exit 2
    ;;
esac
