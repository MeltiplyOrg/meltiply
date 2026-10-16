---
name: circleci-cli
description: CircleCI CLI. Drill down CI runs to the failing step's log, watch, trigger, rerun and cancel, validate and process .circleci config, and manage contexts, env vars, runners, deploys, orbs and artifacts. Use whenever a task touches CircleCI or a build log.
---

# CircleCI CLI

Operate CircleCI from the shell. CircleCI's CLI is **built for agents**: it has a
`--failure-report` flag documented as "intended for agent consumption", a
`--condensed` log mode, machine-readable JSON on every read command, and an MCP
server. Reach for those instead of scraping rendered tables.

## Before anything else

Three facts decide whether a command works. Check them once, at the start of
any CircleCI task, rather than debugging a confusing failure later.

**1. Authenticate.** Every read command needs a token.

```bash
circleci auth me        # exit 0 and a `# User` block means you are good
```

`CIRCLE_TOKEN` in the environment overrides the stored token; otherwise the
token lives in `circleci setting set token <token>`. If `auth me` fails,
everything downstream fails, and it will not say so.

**2. Go non-interactive.** You have no TTY. Without this, a command that would
show a picker either blocks forever or errors out.

```bash
export CIRCLE_NO_INTERACTIVE=1 NO_COLOR=1 PAGER=cat
```

`--no-interactive` on `circleci run get` is the same lever for that one command.

**3. Prefer run UUIDs over project slugs.** A **run UUID** is globally unique
and self-scoping: `circleci run get <uuid>` works with no `--project`, no git
remote, and no slug. Project slugs are the fragile part — `--project` takes
`vcs/org/repo` with exactly three segments, the `vcs` prefix is whatever
CircleCI assigned (`circleci/` for GitHub App installs, not `gh/`), and some
followed projects are **not addressable by slug at all**. When a
`circleci/`-prefixed slug fails, it fails opaquely — a `500 Internal Server
Error`, or `Invalid project slug` from `circleci project link`.

So find the run first and work down from its UUID:

```bash
circleci my runs --limit 20          # run ids across every project you can see
circleci project list --json --jq '.[].slug'   # ground truth for slugs, when you need one
```

Only reach for `--project` when you genuinely have no run UUID, and take the
slug from `project list` verbatim. Inside a repo, omitting `--project` lets the
CLI infer it from the git remote — which is right most of the time and silently
wrong when the remote's provider prefix does not match the CircleCI project.

One trap when you do pass `--project`: the branch then defaults to **`main`**,
not the checked-out branch. Pair it with `--branch` or you will inspect the
wrong branch's run.

## The drill-down

Runs nest: a **project** has **runs**, a run has **workflows**, a workflow has
**jobs**, a job has **steps**, and a step has **output**. Every id you need at
one level is printed by the level above, and every level's ids are globally
unique — so enter the ladder wherever you have an id and work down.

```
run ── run get ──▶ workflow ── workflow get ──▶ job ── job get ──▶ step
                                                                │
                                     job output list ◀──────────┘
                                             │
                                             ▼
                                 job output get --step-num N ──▶ the log
```

**To find out why CI is red**, go straight to the answer:

```bash
circleci run get --failure-report          # latest run on this branch
circleci run get <run-id> --failure-report
```

That prints the failing steps with their condensed output in one call, as plain
text. It **rejects `--json` and `--jq`** (`run.failure_report_no_json`, exit
`2`), so it cannot be piped into a filter — bound it by bytes instead
(`| tail -c 20000`). Reach for the raw ladder when the report is empty,
truncated, or you need a specific step.

`scripts/ci-fail.sh` in this skill directory wraps the ladder and picks the
**causal step** — see [Causal step](#causal-step). Run it from the repository
root when you want the answer bounded and already filtered:

```bash
.agents/skills/circleci-cli/scripts/ci-fail.sh                    # latest run on this branch
.agents/skills/circleci-cli/scripts/ci-fail.sh <run-id> --lines 200   # more log context
.agents/skills/circleci-cli/scripts/ci-fail.sh --job <job-id>         # already know the job
```

It resolves a run UUID the same way you would — explicit id, then the git
remote, then `my runs` — and exits `0` when nothing failed, `1` when something
did, `2` when it could not find the run.

## Causal step

A failed job often has **several** non-zero steps, and only the first one
mattered. Later ones are **teardown noise**: `Stop cache server`,
`Stop containerized PostgreSQL test database`, and friends run under
`when: always`, so they fail _because_ the real step failed. Fixing them is
wasted work.

The causal step is the one with the **lowest step number** and a non-zero exit
code. Two traps when writing this yourself:

- Step numbers are not contiguous (`0, 99, 101, 102, …`) and step `0` is
  `Spin up environment`. Select by the `.num` field, not by array position.
- `null != 0` is **true** in jq, so `select(.exit_code != 0)` matches every
  step that has no exit code and hands you step 0. Exclude null explicitly.

```bash
circleci job output list <job-id> --json \
  --jq '[.steps[] | select(.exit_code != null and .exit_code != 0)] | sort_by(.num) | .[0]'
```

## Reading the output

| Command                                                     | Gives you                                           |
| ----------------------------------------------------------- | --------------------------------------------------- |
| `circleci run get --failure-report`                         | Condensed output of every failed step, one run      |
| `circleci job output list <job-id> --json`                  | Every step with its **full** output and `exit_code` |
| `circleci job output get <job-id> --step-num N --condensed` | One step, error-relevant lines only                 |
| `circleci job output get <job-id> --step-num N`             | One step, **verbatim**                              |

Prefer **condensed** first and widen to verbatim only when the condensed output
does not contain the reason. Condensed is filtered server-side, so it is much
cheaper; verbatim step logs run to megabytes and will blow out a context window.

Parallel jobs have one execution per matrix row. When the step numbers look
right but the output does not match, add `--execution <n>`.

`job output list --tail N` trims the **rendered** view only — `--json` always
carries each step's full output, so `--tail` is not a way to bound a jq
pipeline.

## Exit codes are signals

`circleci run watch` blocks until the run is terminal and encodes the result.
The codes are consistent across the CLI:

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| `0`  | success; for `watch`, all workflows succeeded          |
| `1`  | usage error, or a `watch` that ended with a failure    |
| `2`  | bad arguments, a flag conflict, or an unresolvable run |
| `4`  | HTTP error (`circleci api` on 4xx/5xx)                 |
| `5`  | resolved fine, but the run does not exist              |
| `6`  | cancelled                                              |
| `7`  | invalid orb, or a failing policy test                  |
| `8`  | `watch` timed out (default `--timeout 30m`)            |

**Failures print to stderr, not stdout.** With `--json`, an error is a JSON
object carrying a machine-readable `code`, a `message`, and `suggestions`:

```json
{
  "error": true,
  "code": "git.detect_failed",
  "message": "could not read git remote: repository does not exist",
  "suggestions": [
    "Run from inside a git repository ...",
    "Or specify the project: circleci run list --project gh/org/repo"
  ]
}
```

Read the `suggestions` array before inventing a diagnosis — the CLI usually
names the fix. Redirecting only stdout hides the real error and looks like
empty data.

## JSON shape

**`--jq` does nothing without `--json`.** A bare `--jq` is silently ignored and
you get the rendered markdown report instead of filtered data — no warning, no
error. Always pass both. (`circleci api` is the one exception; it is raw JSON
already.)

Two other flags the CLI's own help text gets wrong, confirmed against
1.0.48692:

- `--json` is a **boolean**. Some help text describes `--json <field-list>`; that
  is stale, and passing fields is an argument error.
- `--template` **does not exist**, despite appearing in the `formatting` help
  topic. It is inherited boilerplate and errors with `unknown flag`.

So `--json` emits a fixed object per command and `--jq` filters it. Two rules
about that object that the help text does not imply:

- Filter on **`.outcome`**, not `.current_outcome`, below run level. A run
  carries both `phase` and `current_outcome`; workflows and jobs carry
  `phase` and `outcome`. Outcomes include `succeeded`, `failed`, `not_run`,
  `canceled`, and `running`.
- The `JSON fields:` line in each command's help is a summary and can disagree
  with the payload. Confirm with `jq 'keys'` before writing a filter that
  depends on it.

```bash
# the failed job ids in a run
circleci run get <run-id> --json --jq '.workflows[].jobs[] | select(.outcome=="failed") | .id'

# every job in the run with its state
circleci run get <run-id> --json --jq '.workflows[].jobs[] | "\(.name) \(.outcome)"'
```

`circleci testresult list --json` is the exception to "one object per command":
it emits **JSONL**, one object per line, so `--jq` runs once per record.
Aggregate with `inputs`:

```bash
circleci testresult list <job-id> --json --jq '[.,inputs] | length'
```

## Where to go next

Load the reference that matches the task. Each is self-contained.

| Task                                                                                                | Read                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Diagnose a failure, read logs, check status, watch, trigger, rerun, cancel, test results, artifacts | [references/TRIAGE.md](references/TRIAGE.md)     |
| Validate or edit `.circleci/config.yml`, split configs, orbs, Rego policy, `env subst`              | [references/CONFIG.md](references/CONFIG.md)     |
| Auth and settings, projects, contexts, env vars, runners, deploys, the REST API, the MCP server     | [references/PLATFORM.md](references/PLATFORM.md) |
| "Is there a command for X?" — the full command surface, one line each                               | [references/COMMANDS.md](references/COMMANDS.md) |

## Discovering the CLI itself

The installed binary documents itself better than any doc site, and **it is the
only version-accurate source**. The published reference can be ahead of or
behind your build: at the time of writing, the online reference described flags
(`--template`, a `--json` field list) that this build does not have, and omitted
commands the build does. Never answer "does this flag exist?" from memory or
from the website.

```bash
circleci <command> <subcommand> --help    # flags, examples, JSON fields, exit codes
circleci reference                        # every command's help in one document
circleci help formatting                  # how --json and --jq combine (partly stale)
circleci help environment                 # env vars: token, host, no-color, pager, no-telemetry
```

`circleci version` tells you which build you have. When a command here does not
behave as documented, `circleci <cmd> --help` wins over both this skill and the
website — and this skill is a cache of the installed CLI, not a replacement for
it.
