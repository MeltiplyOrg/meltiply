#!/usr/bin/env bash
set -euo pipefail

repository_root="${MELTIPLY_REPOSITORY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
release_dir="${MELTIPLY_RELEASE_DIR:-$repository_root/.release}"
tofu_bin="${MELTIPLY_TOFU_BIN:-$repository_root/.bin/tofu}"
iac_dir="$repository_root/infra/cloudflare"

fail() {
  printf 'staging-transition: %s\n' "$*" >&2
  exit 1
}

usage() {
  fail "usage: $0 plan <foundation|pause|paused-consumers|domain|unpause> <tfvars> | apply <phase>"
}

verify_phase() {
  case "$1" in
    foundation | pause | paused-consumers | domain | unpause) ;;
    *) fail "unsupported phase: $1" ;;
  esac
}

# Binds plans and applies to one explicitly selected release commit.
verify_release_sha() {
  [[ "${MELTIPLY_RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "MELTIPLY_RELEASE_SHA must contain exactly 40 lowercase hex characters"

  local checkout_sha
  checkout_sha="$(git -C "$repository_root" rev-parse HEAD)"
  [[ "$checkout_sha" == "$MELTIPLY_RELEASE_SHA" ]] ||
    fail "checked-out commit does not match MELTIPLY_RELEASE_SHA"

  local reviewed_sha_file="$release_dir/reviewed-sha"
  if [[ ! -e "$reviewed_sha_file" ]]; then
    [[ "$action" == "plan" ]] || fail "reviewed-sha is missing"
    printf '%s\n' "$MELTIPLY_RELEASE_SHA" >"$reviewed_sha_file"
  fi

  [[ "$(wc -c <"$reviewed_sha_file")" -eq 41 ]] ||
    fail "reviewed-sha has an invalid length"
  [[ "$(<"$reviewed_sha_file")" == "$MELTIPLY_RELEASE_SHA" ]] ||
    fail "reviewed-sha does not match MELTIPLY_RELEASE_SHA"
}

initialize_backend() {
  : "${MELTIPLY_TF_BACKEND_CONFIG:?MELTIPLY_TF_BACKEND_CONFIG must point to protected backend.hcl}"
  [[ -r "$MELTIPLY_TF_BACKEND_CONFIG" ]] ||
    fail "protected backend configuration is not readable"
  [[ -x "$tofu_bin" ]] || fail "OpenTofu is not installed at $tofu_bin"
  "$tofu_bin" -chdir="$iac_dir" init \
    -reconfigure -input=false \
    -backend-config="$MELTIPLY_TF_BACKEND_CONFIG"
}

plan_transition() {
  local tfvars_path="$1"
  [[ -r "$tfvars_path" ]] || fail "protected $phase tfvars are not readable"

  local plan_file="$release_dir/$phase.tfplan"
  local plan_json="$release_dir/$phase-plan.json"
  local summary="$release_dir/$phase-plan-summary.json"
  local digest_file="$release_dir/$phase-plan.sha256"

  rm -f -- "$plan_file" "$plan_json" "$summary" "$digest_file"
  "$tofu_bin" -chdir="$iac_dir" plan \
    -input=false -lock-timeout=5m \
    -var-file="$tfvars_path" \
    -out="$plan_file"
  "$tofu_bin" -chdir="$iac_dir" show -json "$plan_file" >"$plan_json"

  node "$repository_root/scripts/infra/policy-check.mjs" "$plan_json"
  node "$repository_root/scripts/infra/release-plan.mjs" \
    "$phase" "$plan_json" "$summary"
  sha256sum "$plan_file" | awk '{print $1}' >"$digest_file"
  chmod 600 "$plan_file" "$plan_json" "$summary" "$digest_file"
}

apply_transition() {
  local plan_file="$release_dir/$phase.tfplan"
  local digest_file="$release_dir/$phase-plan.sha256"
  [[ -f "$plan_file" ]] || fail "$phase saved plan is missing"
  [[ -f "$digest_file" ]] || fail "$phase plan digest is missing"
  [[ "$(wc -c <"$digest_file")" -eq 65 ]] ||
    fail "$phase plan digest has an invalid length"

  local expected_digest actual_digest
  expected_digest="$(<"$digest_file")"
  [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail "$phase plan digest is malformed"
  actual_digest="$(sha256sum "$plan_file" | awk '{print $1}')"
  [[ "$actual_digest" == "$expected_digest" ]] ||
    fail "$phase saved plan digest does not match approval evidence"
  [[ "${MELTIPLY_RELEASE_CONFIRM:-}" == "apply $phase $MELTIPLY_RELEASE_SHA $expected_digest" ]] ||
    fail "MELTIPLY_RELEASE_CONFIRM must identify the phase, release commit, and reviewed plan digest"

  "$tofu_bin" -chdir="$iac_dir" apply \
    -input=false -lock-timeout=5m -auto-approve "$plan_file"

  local outputs="$release_dir/iac-outputs-$phase.json"
  local outputs_tmp="$outputs.tmp"
  "$tofu_bin" -chdir="$iac_dir" output -json >"$outputs_tmp"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$outputs_tmp"
  mv -f -- "$outputs_tmp" "$outputs"
  cp -- "$outputs" "$release_dir/iac-outputs.json"
  chmod 600 "$outputs" "$release_dir/iac-outputs.json"

  # The redacted summary and digest are sufficient durable evidence. The raw
  # plan and full plan JSON are deleted immediately after their one approved
  # application and are never eligible for artifact publication.
  rm -f -- "$plan_file" "$release_dir/$phase-plan.json"
}

[[ $# -ge 2 ]] || usage
action="$1"
phase="$2"
verify_phase "$phase"
umask 077
mkdir -p "$release_dir"
verify_release_sha
initialize_backend

case "$action" in
  plan)
    [[ $# -eq 3 ]] || usage
    plan_transition "$3"
    ;;
  apply)
    [[ $# -eq 2 ]] || usage
    apply_transition
    ;;
  *) usage ;;
esac
