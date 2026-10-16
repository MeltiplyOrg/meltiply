# Platform: identity, projects, secrets, runners, deploys, API, MCP

Everything that is not a run and not the config file. Most of these commands
**write** to shared infrastructure, so the pattern is the same: list and read
freely, confirm with the user before anything that mutates.

## Identity and settings

```bash
circleci auth me                       # who am I; the first command to run
circleci auth me --json --jq .login
circleci auth login                    # OAuth via a loopback browser flow
circleci auth login --no-browser       # print the URL instead of opening it
circleci auth logout
circleci auth signup
circleci auth id                       # the id used in a config's context reference
```

`auth login` opens a browser and receives a callback on `127.0.0.1`; it is a
human step, not an agent step. An agent should be given a token instead:

```bash
export CIRCLE_TOKEN=<token>            # per-invocation, wins over stored settings
circleci setting set token <token>     # persisted
circleci setting set token -           # read the token from stdin, avoids shell history
circleci setting unset token
circleci setting list
```

Settings are `token`, `host`, `telemetry`, `theme`, `update-check`, stored in
`~/.config/circleci/config.yml` with the token in the system keyring when one is
available. `circleci setting list` shows the token masked — never echo a full
token into a transcript or a log.

Useful environment variables, all of which beat the stored settings:

| Variable                                                | Effect                                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `CIRCLE_TOKEN`                                          | token for API requests                                    |
| `CIRCLE_HOST`                                           | CircleCI hostname, for a self-hosted install              |
| `CIRCLE_NO_INTERACTIVE`                                 | suppress every interactive prompt                         |
| `CI`                                                    | implies the above, and disables spinner and update checks |
| `NO_COLOR` / `CIRCLE_NO_COLOR`                          | no ANSI escapes                                           |
| `PAGER` / `CIRCLE_NO_PAGER`                             | `PAGER=cat` for pipeable output                           |
| `CIRCLE_NO_TELEMETRY` / `NO_ANALYTICS` / `DO_NOT_TRACK` | disable telemetry                                         |
| `CIRCLE_NO_UPDATE_CHECK`                                | skip the release check                                    |

## Projects

```bash
circleci project list                                  # the slugs you can actually use
circleci project list --json --jq '.[].slug'
circleci project get --project <slug>
circleci project follow                                # enable builds for this repo
circleci project follow --project <slug>
circleci project link                                  # pin the project for this checkout
circleci project link --project <slug> --force
circleci project open
circleci project create <name> --org <vcs/org-slug>
circleci project setting list|get|set
circleci project dlc purge --force
```

`project list` is the ground truth for project slugs — take its output verbatim.
A slug is exactly three segments, `provider/org/repo`, and the `provider` is
whatever CircleCI assigned: `circleci/` for GitHub App installs rather than
`gh/`. Not every followed project is addressable by slug, though. When a
`circleci/`-prefixed slug fails, the failure is opaque — a `500 Internal Server
Error`, or `Invalid project slug` from `project link` — and the way through is a
run UUID, which needs no project at all. See the fallback in `SKILL.md`.

`project link` writes `.circleci/info.yml`, pinning the project for the
checkout so other commands stop re-deriving it from the git remote. It
verifies the slug against the API, so it fails with an auth error when not
logged in, and it cannot bind a slug the API rejects. `-f/--force` overwrites
an existing `info.yml`; that file is project state, so read it before
overwriting.

`project follow` enables builds for a repo. Following an already-followed
project is a no-op.

## Secrets: contexts and env vars

Two scopes, both write-only for values.

**Project env vars** — one project, invisible to other projects:

```bash
circleci envvar list                                  # values masked as xxxx
circleci envvar set MY_VAR value
circleci envvar set MY_VAR "$(cat secret.txt)"        # value from a file
circleci envvar delete MY_VAR
```

`circleci project envvar <list|set|delete>` is the same thing spelled inside the
project group.

**Contexts** — org-scoped, shared across projects, and the thing most projects
use for deploy credentials:

```bash
circleci context list --org <slug>
circleci context create build-secrets --org <slug>
circleci context get <context-id-or-name> --org <slug>
circleci context secret list <context> --org <slug>
circleci context secret set <context> --name KEY --value <val>
circleci context secret delete <context> --name KEY
circleci context restriction create <context> --type project --value <slug>
circleci context restriction delete <context-id> <restriction-id>
circleci context open
```

Values are **never retrievable once set**; every list response masks them. To
confirm a value landed, check the name and the `xxxx` mask, not the content.

`context secret set` prompts for the value when `--value` is omitted **and a
terminal is attached** — pass `--value` in a non-interactive session, or the
command will hang. To feed the value from a pipe or a file:

```bash
circleci context secret set <context> --name KEY --value "$(cat secret.txt)"
circleci context secret set <context> --name KEY --value "$(< secret.txt)"
```

A **restriction** limits which projects may use a context: `project`,
`expression`, or `group`. A context with no restriction is usable by every
project in the org, so check the existing restrictions before assuming a
context is private.

Both `set` commands overwrite silently. Setting an env var is a change to
production behaviour for the next run on every branch — confirm the name, the
value's source, and the project with the user first.

## Runners

```bash
circleci runner resource-class list
circleci runner resource-class create <org>/<name> --description "..." --generate-token
circleci runner resource-class delete <org>/<name>
circleci runner instance list
circleci runner token list <org>/<name>
circleci runner token create <org>/<name>
circleci runner token delete <org>/<name>
circleci runner config
circleci runner open
```

Names are always `namespace/name`, where the namespace is the organization.
`--generate-token` on `resource-class create` also creates a token nicknamed
`default`.

A runner **token is a credential** — it authorises a machine to pick up and run
jobs. It is displayed once and never again. Never print one into a transcript,
a log, a commit, or a PR body; hand it to the user through a secret channel.

## Deploys

CircleCI's release tracking: components, versions, environments, and rollbacks.

```bash
circleci deploy init --component api --environment production
circleci deploy list
circleci deploy list --json
circleci deploy settings
circleci deploy component list
circleci deploy component get <name>
circleci deploy environment list
circleci deploy environment get <name>
circleci deploy version list <component>
circleci deploy rollback <version> --component <c> --environment <e> --reason "..." --force
circleci deploy open
```

`deploy init` scans the config for deploy-like jobs — names containing
`deploy`, `release`, `publish`, or `ship` — and adds a marker step to each. It
is **idempotent**, so re-running makes no duplicate changes. It edits
`.circleci/config.yml` in place, so commit the result and validate afterwards.

`deploy list` JSON fields: `id`, `component_name`, `version`, `type`, `status`,
`is_rollback`, `pipeline_id`, `workflow_id`, `created_at`, `ended_at`. Finding
the version currently live in an environment is a filter over that list — which
is what `deploy rollback` needs for `--from`.

`deploy rollback` **replaces a deployed version**. Pass `--reason` — it is
written to the audit log — and `--force` to skip the prompt. Both `--component`
and `--environment` are required, and `--from` must name the version currently
deployed. Treat a rollback as a production change: confirm the target version
and environment with the user, and never run one unprompted.

## The REST API escape hatch

When the CLI has no command for something, it will still make the call. The
token is attached for you and the raw body is printed.

```bash
circleci api api/v2/me
circleci api projects/<project-id>/runs
circleci api projects/<id>/run -f definition_id=<id> -f "config[branch]=main"
circleci api projects/<id>/run -d @payload.json
circleci api api/v1.1/me -H "X-Custom: value"
```

| Flag                        | Effect                                                       |
| --------------------------- | ------------------------------------------------------------ |
| `-X, --method`              | HTTP method; defaults to GET, or POST when `-f`/`-d` is used |
| `-f, --field key=value`     | query param on GET/DELETE, JSON body field on POST/PUT/PATCH |
| `-d, --data`                | raw body, verbatim; `@file` or `@-` for stdin                |
| `-H, --header "Key: Value"` | extra request header                                         |
| `--jq`                      | filter the response                                          |

Paths are relative to **`/api/v3`** by default, and that default is the trap:
the CLI's own example `circleci api me` hits `/api/v3/me` and fails. Include the
version prefix explicitly — `circleci api api/v2/me`.

Exit code is `0` for 2xx and `4` for 4xx/5xx, so a script can branch on it.
Response bodies can embed credentials, so do not dump a raw `--json` response
into a shared channel.

The documented way to trigger a pipeline with parameters, which is also what a
`setup:` config expects:

```bash
curl -X POST "https://circleci.com/api/v2/project/<project-slug>/pipeline" \
  -H "Circle-Token: $CIRCLE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"branch":"master","parameters":{"staging-release":true}}'
```

## MCP server

The CLI can expose itself to an MCP client instead of being shelled out.

```bash
circleci mcp start                  # stdio server
circleci mcp stream --port 8080     # HTTP server
circleci mcp tools                  # export the tool manifest to mcp-tools.json
circleci mcp claude enable|disable|list
circleci mcp cursor enable|disable|list
circleci mcp vscode  enable|disable|list
```

`mcp tools` writes a manifest of every exposed tool to `mcp-tools.json` in the
**current directory** (it fails in a read-only one). The surface is well over a
hundred tools, one per CLI command, named `circleci_<group>_<path>`
(`circleci_run_get`, `circleci_job_output_list`, `circleci_config_validate`),
each taking `{args[], flags{}}` and returning `{stdout, stderr, exitCode}`.
Run `circleci mcp tools` to read the current surface for the installed version
instead of trusting a count.

The tool set includes every **mutating** command — env vars, contexts, orb
publishing, deploy rollbacks, runners. Enabling the server grants the client's
AI full write scope over the token's account, so treat enabling it as a
privileged action and confirm with the user first.

Prefer the CLI when a shell is already available: the CLI composes (`--json
--jq` pipelines, `xargs`, exit codes) and the MCP tools are one command per
call. Reach for MCP when the host has no shell or already manages the
connection.

## Everything else

```bash
circleci org list
circleci org setting list|get|set        # org-level settings
circleci dlc purge --force               # Docker layer cache; forces a full rebuild
circleci extension install <name>        # e.g. testsuite
circleci extension remove <name>
circleci completion install <shell>      # bash, zsh, fish, powershell
circleci version
```

`dlc purge` is the fix for a stale or corrupt cached Docker layer: it forces
every layer to rebuild on the next run, which costs a slow build. Reach for it
only after a cache is suspected, not as a first response to a failure.

`extension install` downloads a binary, verifies its SHA-256 against the
release manifest, and records a manifest file for later upgrade or removal.
`circleci-testsuite` is the official extension and is not installed by default —
`circleci testsuite` errors until you do.
