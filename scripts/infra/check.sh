#!/usr/bin/env bash
set -euo pipefail

./scripts/infra/install-opentofu.sh
export OPENTOFU_ENFORCE_GPG_VALIDATION=true

.bin/tofu -chdir=infra/cloudflare fmt -check -recursive
.bin/tofu -chdir=infra/cloudflare init -backend=false -lockfile=readonly
.bin/tofu -chdir=infra/cloudflare validate
.bin/tofu -chdir=infra/cloudflare test
node ./scripts/infra/policy-check.mjs
node ./scripts/infra/cost-model.mjs --check
node --test ./scripts/infra/*.test.mjs

if [[ -n "${MELTIPLY_IAC_TFVARS:-}" ]]; then
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "CLOUDFLARE_API_TOKEN is required for an infrastructure plan" >&2
    exit 1
  fi
  .bin/tofu -chdir=infra/cloudflare plan \
    -input=false \
    -lock=false \
    -refresh=false \
    -var-file="$MELTIPLY_IAC_TFVARS" \
    -out=plan.tfplan
  .bin/tofu -chdir=infra/cloudflare show -json plan.tfplan \
    >infra/cloudflare/plan.json
  node ./scripts/infra/policy-check.mjs infra/cloudflare/plan.json
else
  echo "MELTIPLY_IAC_TFVARS is unset; validated configuration/policy without a remote plan."
fi
