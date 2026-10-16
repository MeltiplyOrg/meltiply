#!/usr/bin/env bash
# ci-fail: print the causal failure of a CircleCI run, bounded.
#
# Walks the run -> workflow -> job -> step ladder and reports the *first*
# step with a non-zero exit code per failed job, skipping teardown noise,
# then prints that step's condensed log.
#
# Usage:
#   ci-fail.sh [run-id] [options]
#
#   run-id          run UUID or run number. Default: latest run on this branch,
#                   resolved from the git remote, then from `circleci my runs`.
#   --project SLUG  vcs/org/repo. Default: inferred from the git remote.
#   --branch NAME   branch for the default-run lookup. Default: current branch.
#   --all-failed    report every non-zero step, not just the first.
#   --lines N       condensed log tail lines per step (default 60).
#   --job ID        skip the run->job walk and inspect this job directly.
#   -h|--help       this help.
#
# Exit codes: 0 no failures found, 1 failures found, 2 usage/lookup error.
set -uo pipefail

LINES=60
RUN=""
PROJECT=""
BRANCH=""
ALL_FAILED=0
JOB=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --branch)  BRANCH="${2:-}";  shift 2 ;;
    --lines)   LINES="${2:-}";   shift 2 ;;
    --job)     JOB="${2:-}";     shift 2 ;;
    --all-failed) ALL_FAILED=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)  RUN="$1"; shift ;;
  esac
done

# Non-interactive by default: no pickers, no pagers, no colour, no spinner.
export CIRCLE_NO_INTERACTIVE=1
export NO_COLOR=1
export PAGER=cat

cc() { circleci "$@"; }

# Resolve a run UUID to report on, in decreasing order of robustness.
#
# A run UUID is self-scoping: `run get <uuid>` works with no project and no git
# remote. Resolving "the latest run" needs a project slug, and not every
# followed project is addressable by slug (a `circleci/`-prefixed slug can fail
# with a 500 or "Invalid project slug"), so fall back to `my runs` — which needs
# neither — and take the newest run for the current branch.
resolve_run() {
  if [ -n "$RUN" ]; then printf '%s' "$RUN"; return; fi

  local args=(run get --no-interactive --json)
  [ -n "$PROJECT" ] && args+=(--project "$PROJECT")
  [ -n "$BRANCH" ] && args+=(--branch "$BRANCH")
  local id
  id="$(cc "${args[@]}" 2>/dev/null | jq -r '.id // empty')"
  [ -n "$id" ] && { printf '%s' "$id"; return; }

  cc my runs --limit 50 --json 2>/dev/null \
    | jq -r --arg b "${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}" \
           '[.[] | select(.branch == $b)] | (.[0].id // empty)'
}

# Print "job-id<TAB>job-name" for every failed job in the run.
failed_jobs() {
  local run="$1"
  cc run get "$run" --json 2>/dev/null \
    | jq -r '.workflows[] | .id as $wf | .jobs[]
             | select(.outcome == "failed")
             | "\(.id)\t\(.name)\t\($wf)"'
}

# Print "step-num<TAB>step-name" for steps that exited non-zero, lowest first.
# `null != 0` is true in jq, so exit_code must be excluded explicitly or step 0
# ("Spin up environment") wins the min().
failed_steps() {
  local job="$1"
  cc job output list "$job" --json 2>/dev/null \
    | jq -r '[.steps[] | select(.exit_code != null and .exit_code != 0)]
             | sort_by(.num)
             | .[]
             | "\(.num)\t\(.name)"'
}

report_job() {
  local job="$1" name="$2" count=0
  local steps
  steps="$(failed_steps "$job")"
  [ -z "$steps" ] && {
    echo "== job $name ($job)"
    echo "   no step reported a non-zero exit code; inspect: circleci job get $job"
    return
  }
  echo "== job $name ($job)"
  while IFS=$'\t' read -r num step_name; do
    [ -z "$num" ] && continue
    if [ "$ALL_FAILED" -eq 0 ] && [ "$count" -ge 1 ]; then break; fi
    count=$((count + 1))
    echo
    echo "-- step $num: $step_name"
    circleci job output get "$job" --step-num "$num" --condensed 2>/dev/null | tail -n "$LINES"
  done <<< "$steps"
  [ "$ALL_FAILED" -eq 0 ] && [ "$count" -gt 1 ] && echo && \
    echo "(+$(( $(printf '%s\n' "$steps" | wc -l) - 1 )) more failing step(s); re-run with --all-failed)"
}

if [ -n "$JOB" ]; then
  report_job "$JOB" "$(cc job get "$JOB" 2>/dev/null | sed -n 's/^- Name: //p')"
  exit 1
fi

RUN="$(resolve_run)"
[ -z "$RUN" ] && {
  echo "ci-fail: could not resolve a run." >&2
  echo "  - is 'circleci auth me' working?" >&2
  echo "  - does this branch have a run? try: circleci my runs" >&2
  echo "  - or pass one explicitly: $0 <run-uuid>" >&2
  exit 2
}

echo "run $RUN"
# .commit.subject carries the whole commit message; keep the first line only.
subject="$(cc run get "$RUN" --json 2>/dev/null | jq -r '(.commit.subject // "") | split("\n")[0]')"
[ -n "$subject" ] && echo "  $subject"
echo

jobs="$(failed_jobs "$RUN")"
if [ -z "$jobs" ]; then
  # No failed job: report the run's own outcome from JSON so the workflow and
  # job tables in the rendered view cannot bleed into this line.
  outcome="$(cc run get "$RUN" --json 2>/dev/null | jq -r '.current_outcome // "unknown"')"
  echo "no failed jobs; run outcome: $outcome"
  exit 0
fi

while IFS=$'\t' read -r job_id job_name wf; do
  [ -z "$job_id" ] && continue
  report_job "$job_id" "$job_name"
  echo
done <<< "$jobs"
exit 1
