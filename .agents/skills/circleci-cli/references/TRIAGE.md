# Inspecting runs and diagnosing failures

The high-traffic path: what is CI doing, why did it fail, get the log, fix it,
run it again. `SKILL.md` has the ladder and the non-interactive contract; this
file has the commands.

## Find a run

**Start from a run UUID.** UUIDs are self-scoping, so `circleci run get <uuid>`
works with no `--project` and no git remote — the robust path when a slug does
not resolve. `circleci my runs` is how you get one.

```bash
circleci my runs --limit 20             # your runs across every project you can see
circleci run list                       # recent runs for this project
circleci run list -B                    # -B: only the checked-out branch
circleci run list --branch main --limit 25
circleci run list --project <slug> --json
```

Inside a repo, the project comes from the git remote unless `--project` is
given, and the branch from the checked-out branch. Two things go wrong here:

- **The remote's provider prefix may not match the CircleCI project.** A
  GitHub App project is `circleci/org/repo`, and a `gh/` remote infers
  `gh/...`, which then fails with a misleading "No run found". When that
  happens, take the slug from `circleci project list --json --jq '.[].slug'`.
- **`--project` changes the branch default to `main`**, not the checked-out
  branch. Always pair it with `--branch`.

The rendered table is a good human summary: project, ref, short revision, run
id, created time, status. `run list --json` adds the full commit and repository
detail — `id`, `phase`, `outcome`, `current_outcome`, `branch`, `tag`,
`revision`, `repository_url`, `commit.subject/url/author_name/author_login`,
`created_at`.

Run ids appear in two shapes and the commands accept either: the **UUID** from
`--json`, and the short **number** from the rendered table. Prefer the UUID;
it is unambiguous. Note that `my runs` reports each run's project as a
two-segment `org/repo`, which is **not** a valid `--project` slug — use its
`id` and drop the `project` column.

A `[ci skip]` commit, or a filtered path, produces no run at all. "No run found"
usually means the branch never built rather than that the branch is green.
Confirm with `circleci run list --branch <name>` before reporting a failure.

## Watch a run

```bash
circleci run watch                      # latest run on this branch
circleci run watch <run-id>
circleci run watch --sha $(git rev-parse HEAD)   # right after a push
circleci run watch --failfast --timeout 45m
```

`watch` blocks until the run reaches a terminal state and exits `0` all-good,
`1` failed, `6` cancelled, `8` timed out. Use the exit code, not the output.

`--sha` polls for up to two minutes waiting for a run on that commit to appear,
which closes the race between `git push` and the run being created. The
canonical push-and-verify pair is:

```bash
git push && circleci run watch --sha "$(git rev-parse HEAD)" --failfast
```

`--failfast` exits on the first job failure rather than waiting out the rest,
which is what you want when iterating on a fix. Without a TTY, `watch` prints
one line per change instead of a live table, so it pipes cleanly.

## Diagnose a failure

Fastest path, one call:

```bash
circleci run get --failure-report
circleci run get <run-id> --failure-report
```

This walks every workflow, finds the failed jobs, and prints each failed step's
condensed output with its exit code. It prints nothing when the run succeeded.
It is **plain text only** — combining it with `--json` or `--jq` fails with
`run.failure_report_no_json` and exit `2`, so you cannot pipe it into a filter.
Bound it by bytes on a long log:

```bash
circleci run get <run-id> --failure-report | tail -c 20000
```

Manual ladder, when the report is empty or you need a specific step:

```bash
# 1. the run
circleci run get <run-id>                      # workflows, jobs, ids, statuses

# 2. the failed job ids
circleci run get <run-id> --json --jq '.workflows[].jobs[] | select(.outcome=="failed") | .id'

# 3. the job and its step table
circleci job get <job-id>                      # step numbers, names, exit codes, timings

# 4. the steps that actually failed, lowest first
circleci job output list <job-id> --json \
  --jq '.steps[] | select(.exit_code != null and .exit_code != 0) | "\(.num) \(.name)"'

# 5. the log
circleci job output get <job-id> --step-num 114 --condensed
```

`job get` also carries the steps, under `executions[].steps[]` — useful when
you want them without the output payload:

```bash
circleci job get <job-id> --json \
  --jq '.executions[].steps[] | select(.exit_code != null and .exit_code != 0) | "\(.name) exit=\(.exit_code)"'
```

`--jq` on its own is silently ignored and prints the rendered report; every
filtering command here needs `--json --jq` together.

Filter workflows instead of jobs when you care about a named workflow:

```bash
circleci run get <run-id> --json --jq '.workflows[] | select(.name=="build-and-test") | .jobs[] | "\(.name) \(.outcome)"'
```

`run get` also accepts `--project` and `--branch` to resolve the latest run,
and `--no-interactive` to skip the picker when a TTY _is_ present but you want
determinism. Add `--mine` to restrict to runs you triggered.

## The failing step's log

`job output get` fetches stdout and stderr for one step and prints them
together, stdout first.

| Flag              | Effect                                                         |
| ----------------- | -------------------------------------------------------------- |
| `--condensed`     | Error-relevant lines only, filtered server-side. Experimental. |
| `--strip-ansi`    | Force ANSI stripping (default: strip only when not a TTY)      |
| `--execution <n>` | Which parallel execution to read                               |

`job output list` is the bulk read: every step with its terminal-processed
output, progress redraws collapsed to their final state, so a TUI-heavy build
reads the way a human saw it.

| Flag              | Effect                                                       |
| ----------------- | ------------------------------------------------------------ |
| `--json`          | Full output for every step, as `steps[].output`              |
| `--tail <n>`      | Trims the **rendered** view only; default `200`, `0` for all |
| `--execution <n>` | Which parallel execution to list                             |

JSON fields: `id`, `name`, `execution`,
`steps[].num/name/type/phase/outcome/started_at/stopped_at/exit_code/command/output`.

`--tail` and `--json` do not compose into a bound: `--json` always carries full
output. To keep a jq pipeline small, select the field you want rather than
relying on the rendered trim.

```bash
# the output of just the failing steps
circleci job output list <job-id> --json --jq '.steps[] | select(.exit_code != null and .exit_code != 0) | .output'

# the command a step ran, without the log
circleci job output list <job-id> --json --jq '.steps[] | "\(.num)\t\(.command)"'
```

Widen `--condensed` to verbatim only when the condensed lines do not contain the
reason. Verbatim is where the panic message, the stack trace, and the real
error live.

## Test results

When a job ran tests, the structured results beat the log.

```bash
circleci testresult list <job-id>                  # failed tests only, by default
circleci testresult list <job-id> --all            # passing, failed and skipped
circleci testresult list <job-id> --filter result=skipped
circleci testresult list <job-id> --filter classname=api --sort run_time
circleci testresult list <job-id> --limit 0        # no limit
```

`--filter` takes `key=value` and is repeatable: `result` is exact
(`success|failure|skipped`), `name` and `classname` are case-insensitive
substrings. The same key repeated is OR; different keys are AND. `--all` cannot
be combined with a `result=` filter — pick one.

```bash
circleci testresult get <job-id> TestLogin                     # by exact name
circleci testresult get <job-id> TestLogin --filter classname=api
circleci testresult get <job-id> TestLogin --plain             # raw message, unformatted
```

A bare name is ambiguous and the lookup fails when several tests share it;
disambiguate with `--filter classname=`. `--plain` prints the failure message
verbatim, which is usually the highest-signal single line in the job.

The JSON is **JSONL** — one object per test, so `--jq` runs per record. Count
with `[.,inputs] | length`, or filter with `inputs`:

```bash
circleci testresult list <job-id> --json --jq 'select(.result=="failure") | .name'
circleci testresult list <job-id> --json --jq '[inputs | select(.result=="failure")] | length'
```

## Artifacts

```bash
circleci artifact <job-id>                        # list
circleci job artifact <job-id>                    # same command, nested spelling
circleci job artifact <job-id> --output ./artifacts   # download
circleci job artifact <job-id> --json --jq '.[].path'
```

JSON fields: `path`, `url`, `execution`. One entry per parallel execution, so a
matrix job lists each row's artifacts. Download to a scratch directory rather
than the repo root; artifacts are frequently large and never belong in a commit.

## Rerun, cancel, and retrigger

```bash
circleci workflow rerun <workflow-id>                       # all jobs, from scratch
circleci workflow rerun <workflow-id> --from-failed         # only the failed jobs
circleci workflow rerun <workflow-id> --from-failed --json --jq .workflow_id
```

A rerun creates a **new** workflow; capture its id and watch that, not the
original run. `--from-failed` is the cheap loop when iterating on a fix.

Workflow ids come from `circleci run get`:

```bash
circleci run get <run-id> --json --jq '.workflows[] | "\(.id) \(.name)"'
```

```bash
circleci workflow cancel <workflow-id>              # prompts
circleci workflow cancel <workflow-id> --force      # no prompt — always pass this
circleci run cancel <run-id> --force                # stops all in-progress work
```

Cancelling is interactive by default and will block. **Always pass `--force`**
from a script or an agent session. Cancelling a run leaves completed workflows
untouched.

Find and cancel a stuck run in one line:

```bash
circleci run list --branch main --json --jq '.[0].id' | xargs circleci run cancel --force
```

## Trigger a run

```bash
circleci run trigger                                            # current branch
circleci run trigger --branch main --parameter run_e2e=true --parameter deploy_env=staging
circleci run trigger --json --jq .id
```

`--parameter` is repeatable and typed: `true`/`false` become booleans, bare
integers become integers, everything else stays a string. Values must match the
`parameters:` block in the config or the run is rejected.

Then watch the id it returns:

```bash
circleci run trigger --json --jq .id | xargs circleci run watch --failfast
```

`run trigger` triggers the default pipeline. For a non-default pipeline, or a
tag, use `pipeline run` — it needs a definition id:

```bash
circleci pipeline list --project <slug> --json --jq '.[] | "\(.id) \(.name)"'
circleci pipeline run --project <slug> --definition-id <id> --branch main --param k=v
circleci pipeline run --project <slug> --definition-id <id> --tag v1.2.3
```

Omitting `--definition-id` prompts, so it is mandatory in non-interactive mode.
`--branch` and `--tag` are mutually exclusive and each sets both the
config-fetch and the checkout revision. A skipped pipeline — a `[ci skip]`
commit, say — exits `0` and prints why, which is not a failure.

Some projects declare `parameters` that only exist on a continuation or setup
pipeline, and re-sending a trigger-time parameter to the continuation makes
CircleCI report conflicting parameters. Read the `parameters:` block in
`.circleci/config.yml` before composing a trigger, and check what the config's
own comments say about which pipeline owns which flag.

## Watch the cost of a job

```bash
circleci job resource-usage get <job-id>
circleci job resource-usage get <job-id> --json \
  --jq '.executions[].memory.peak_percent_of_limit'
```

Charts CPU and memory against the resource class limits. A peak under 50% on
both means a smaller resource class fits — that is the evidence for a right-
sizing change. JSON fields include
`resource_class.name/cpu_count/memory_limit_bytes` and, per execution,
`cpu_cores/memory_bytes/network_rx_bytes/network_tx_bytes` with
`cpu.min/mean/max/peak_percent_of_limit` and the same for memory.
`--chart combined|separate` controls whether parallel executions are overlaid.

## Open in the browser

`circleci run open`, `workflow open`, `job open`, `project open`, `context open`,
`deploy open`, `runner open` open the corresponding page. They launch a browser,
which is a no-op or a failure in a headless session. Use them only when handing
a link to a human; prefer the `--json` output, which already contains the
`circleci.com` URL for the run, workflow, and job.
