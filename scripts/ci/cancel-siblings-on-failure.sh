#!/usr/bin/env bash
# A failed job is the authoritative failure record. Cancel only other active
# workflows in the same pipeline so parallel work stops without replacing that
# record with a canceled outcome. Sequential staging jobs already stop through
# their `requires` dependencies.
set -uo pipefail

api_base="${CIRCLECI_API_BASE_URL:-https://circleci.com/api/v2}"
warn() { printf 'cancel-siblings-on-failure: %s\n' "$1" >&2; }

if [ -z "${CIRCLE_TOKEN:-}" ] || [ -z "${CIRCLE_PIPELINE_ID:-}" ] ||
  [ -z "${CIRCLE_WORKFLOW_ID:-}" ]; then
  warn "missing CircleCI token or pipeline/workflow identity; skipping cancellation"
  exit 0
fi

workflows="$(
  curl --fail --silent --show-error \
    --header "Circle-Token: ${CIRCLE_TOKEN}" \
    "${api_base}/pipeline/${CIRCLE_PIPELINE_ID}/workflow"
)" || {
  warn "could not list pipeline workflows"
  exit 0
}

if ! sibling_ids="$(
  jq -r --arg current "${CIRCLE_WORKFLOW_ID}" '
    .items[]
    | select(.id != $current)
    | select(.name != "setup")
    | .status as $status
    | select(
        ["success", "failed", "canceled", "unauthorized", "not_run", "infrastructure_fail", "timedout"]
        | index($status)
        | not
      )
    | .id
  ' <<<"${workflows}"
)"; then
  warn "could not select active sibling workflows"
  exit 0
fi

for workflow_id in ${sibling_ids}; do
  if curl --fail --silent --show-error --output /dev/null --request POST \
    --header "Circle-Token: ${CIRCLE_TOKEN}" \
    "${api_base}/workflow/${workflow_id}/cancel"; then
    printf 'canceled sibling workflow %s\n' "${workflow_id}"
  else
    warn "could not cancel sibling workflow ${workflow_id}"
  fi
done
