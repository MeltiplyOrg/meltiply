#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

cat >"$temp_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
printf '%s\n' "$url" >>"$CURL_CALLS"
if [[ "$url" == */pipeline/test-pipeline/workflow ]]; then
  printf '%s\n' "$WORKFLOW_PAYLOAD"
elif [[ "$url" == */workflow/*/cancel ]]; then
  printf '{}\n'
else
  printf 'unexpected curl URL: %s\n' "$url" >&2
  exit 1
fi
EOF
chmod +x "$temp_dir/curl"

calls="$temp_dir/calls"
: >"$calls"
WORKFLOW_PAYLOAD='{"items":[
  {"id":"current","name":"baseline","status":"failed"},
  {"id":"setup","name":"setup","status":"success"},
  {"id":"frontend","name":"frontend-fast","status":"running"},
  {"id":"extended","name":"cloudflare-extended","status":"on_hold"},
  {"id":"completed","name":"cloudflare-fast","status":"success"},
  {"id":"skipped","name":"ci-gate","status":"not_run"}
]}' \
  CURL_CALLS="$calls" \
  PATH="$temp_dir:$PATH" \
  CIRCLE_TOKEN=test-token \
  CIRCLE_PIPELINE_ID=test-pipeline \
  CIRCLE_WORKFLOW_ID=current \
  "$script_dir/cancel-siblings-on-failure.sh" >"$temp_dir/output" 2>&1

for workflow_id in frontend extended; do
  grep -Fqx "https://circleci.com/api/v2/workflow/${workflow_id}/cancel" "$calls"
done
for workflow_id in current setup completed skipped; do
  if grep -Fq "/workflow/${workflow_id}/cancel" "$calls"; then
    printf 'unexpected cancellation for %s\n' "$workflow_id" >&2
    exit 1
  fi
done

set +e
env -u CIRCLE_TOKEN \
  CIRCLE_PIPELINE_ID=test-pipeline \
  CIRCLE_WORKFLOW_ID=current \
  "$script_dir/cancel-siblings-on-failure.sh" >"$temp_dir/no-token" 2>&1
status=$?
set -e
test "$status" -eq 0
grep -Fq 'missing CircleCI token' "$temp_dir/no-token"

printf 'Sibling workflow cancellation active/terminal filtering and best-effort behavior passed.\n'
