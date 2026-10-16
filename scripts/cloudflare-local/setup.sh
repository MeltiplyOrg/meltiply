#!/usr/bin/env bash
set -euo pipefail

skip_dependencies=false
skip_image_pull=false

while (($# > 0)); do
  case "$1" in
    --skip-dependencies)
      skip_dependencies=true
      ;;
    --skip-image-pull)
      skip_image_pull=true
      ;;
    --)
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      printf 'usage: %s [--skip-dependencies] [--skip-image-pull]\n' "$0" >&2
      exit 2
      ;;
  esac
  shift
done

copy_example() {
  local example=$1
  local target=${example%.example}
  if [[ ! -e "$target" ]]; then
    cp "$example" "$target"
    printf 'created %s from its non-secret example\n' "$target"
  fi
}

add_missing_example_keys() {
  local example=$1
  local target=${example%.example}
  while IFS= read -r line; do
    if [[ "$line" != *=* || "$line" == \#* ]]; then
      continue
    fi
    local key=${line%%=*}
    if ! grep -qE "^${key}=" "$target"; then
      printf '%s\n' "$line" >>"$target"
      printf 'added missing local placeholder %s to %s\n' "$key" "$target"
    fi
  done <"$example"
}

# Existing local .env files may still have BILLING_WEBHOOK_SECRET= from the
# Polar cutover. Empty secrets make invalid webhooks 503 instead of the OpenAPI
# 401 signature path that local smoke/live-worker conformance require.
ensure_local_billing_webhook_secret() {
  local target=.env
  local example_value current_value
  example_value="$(
    grep -E '^BILLING_WEBHOOK_SECRET=' .env.example | head -n 1 | cut -d= -f2-
  )"
  [[ -n "$example_value" ]] || return 0
  [[ -f "$target" ]] || return 0
  current_value="$(
    grep -E '^BILLING_WEBHOOK_SECRET=' "$target" | head -n 1 | cut -d= -f2-
  )"
  # Only fill truly empty placeholders; never overwrite a real secret.
  if [[ -z "${current_value//[[:space:]]/}" ]]; then
    local tmp
    tmp="$(mktemp)"
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == BILLING_WEBHOOK_SECRET=* ]]; then
        printf 'BILLING_WEBHOOK_SECRET=%s\n' "$example_value"
      else
        printf '%s\n' "$line"
      fi
    done <"$target" >"$tmp"
    mv "$tmp" "$target"
    printf 'filled empty local placeholder BILLING_WEBHOOK_SECRET in %s\n' "$target"
  fi
}

if [[ "$skip_dependencies" == false ]]; then
  if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "1.4.2" ]]; then
    echo "Bun 1.4.2 is required alongside Node.js 24.18.0." >&2
    echo "Install it with: curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2" >&2
    exit 1
  fi

  bun install --frozen-lockfile
  ./scripts/infra/install-opentofu.sh
else
  echo "skipped dependency installation"
fi

copy_example .env.example
add_missing_example_keys .env.example
ensure_local_billing_webhook_secret

if [[ "$skip_image_pull" == false ]]; then
  # Pull through the shared Compose boundary so a devcontainer resolves the
  # same scoped project and overlay the database lifecycle uses.
  ./scripts/cloudflare-local/compose.sh pull postgres
else
  echo "skipped explicit compose image pull"
fi
./scripts/cloudflare-local/database.sh seed

printf '\nCloudflare-target setup is ready. Run `bun run dev:backend`.\n'
printf 'Seed sign-in: alpha@meltiply.local / MeltiplyLocal1! (creator workspace)\n'
