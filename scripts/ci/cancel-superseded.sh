#!/usr/bin/env bash
# Cancel superseded pipelines: when several commits land on the same branch in
# quick succession, only the newest pipeline needs to finish.  This runs as the
# first step of the always-on baseline job and cancels older pipelines of the
# same non-default branch.  Each run only targets pipelines created before
# itself, so two runs racing cannot cancel each other.  Default-branch pushes
# are never cancelled.
#
# CircleCI Note on Native Auto-Cancel:
# CircleCI offers a native "Auto-cancel redundant builds" toggle under:
#   Project Settings -> Advanced -> "Auto-cancel redundant builds".
# However, that feature is dashboard-only and cannot be managed declaratively
# in repository configuration. Furthermore, with CircleCI dynamic continuation
# pipelines (setup workflows), native auto-cancel often only cancels the setup
# workflow rather than in-flight continued workflows. This script guarantees
# deterministic cancellation of older pipelines on feature branches without
# risking accidental cancellation of master pushes.
set -euo pipefail

: "${CIRCLE_TOKEN:?CIRCLE_TOKEN is required to cancel superseded pipelines}"
: "${CIRCLE_PIPELINE_ID:?CIRCLE_PIPELINE_ID is required to cancel superseded pipelines}"

api_base="${CIRCLECI_API_BASE_URL:-https://circleci.com/api/v2}"
default_branch="${CIRCLE_DEFAULT_BRANCH:-master}"

# Cost optimization only: report problems, never fail the job over them.
warn() { printf 'cancel-superseded: %s\n' "$1" >&2; }

if [ -z "${CIRCLE_BRANCH:-}" ] || [ "${CIRCLE_BRANCH}" = "${default_branch}" ]; then
  exit 0
fi

api_get() {
  curl --fail --silent --show-error \
    --header "Circle-Token: ${CIRCLE_TOKEN}" \
    "${api_base}$1"
}

metadata="$(mktemp)"
branch_pipelines="$(mktemp)"
trap 'rm -f "${metadata}" "${branch_pipelines}"' EXIT

if ! api_get "/pipeline/${CIRCLE_PIPELINE_ID}" >"${metadata}"; then
  warn "could not read current pipeline metadata"
  exit 0
fi

project_slug="$(jq -r '.project_slug // empty' "${metadata}")"
created_at="$(jq -r '.created_at // empty' "${metadata}")"
if [ -z "${project_slug}" ] || [ -z "${created_at}" ]; then
  warn "current pipeline metadata incomplete"
  exit 0
fi

branch_query="$(jq -rn --arg branch "${CIRCLE_BRANCH}" '$branch | @uri')"
if ! api_get "/project/${project_slug}/pipeline?branch=${branch_query}" \
  >"${branch_pipelines}"; then
  warn "could not list pipelines for branch ${CIRCLE_BRANCH}"
  exit 0
fi

# ISO-8601 UTC timestamps sort lexicographically, so string comparison here is
# an exact creation-time ordering.
superseded_ids="$(
  jq -r --arg mine "${CIRCLE_PIPELINE_ID}" --arg created_at "${created_at}" '
    .items[]
    | select(.id != $mine)
    | select(.created_at < $created_at)
    | .id
  ' "${branch_pipelines}"
)"

cancelled=0
for pipeline_id in ${superseded_ids}; do
  if curl --fail --silent --show-error --output /dev/null --request POST \
    --header "Circle-Token: ${CIRCLE_TOKEN}" \
    "${api_base}/pipeline/${pipeline_id}/cancel"; then
    printf 'canceled superseded pipeline %s\n' "${pipeline_id}"
    cancelled=$((cancelled + 1))
  else
    warn "could not cancel pipeline ${pipeline_id} (likely already finished)"
  fi
done

if ((cancelled > 0)); then
  printf 'canceled %d superseded pipeline(s) for branch %s\n' \
    "${cancelled}" "${CIRCLE_BRANCH}"
fi
