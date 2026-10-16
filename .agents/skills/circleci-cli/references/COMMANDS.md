# The command surface

Every command in the CircleCI CLI, one line each, so "is there a command for
X?" is answerable without recalling flags. This is a map, not a manual: the
installed binary's own help is authoritative, and this file can drift from it.

```bash
circleci <command> <subcommand> --help   # flags, examples, JSON fields, exit codes
circleci reference                       # every command's help in one document
```

Three rules that hold for every row below, so they are not repeated:

- `--jq` does nothing without `--json`. Both, always.
- The branch defaults to the checked-out branch — except with `--project`,
  where it defaults to `main`.
- `cancel` and other destructive commands prompt unless given `--force`
  (`policy push` uses `--no-prompt`).

## Runs — see [TRIAGE.md](TRIAGE.md)

| Command            | Does                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `run list` (`ls`)  | recent runs for a project; `-B/--current-branch`, `--branch`, `--limit`, `--json` |
| `run get [<id>]`   | one run's workflows and jobs; resolves latest when the id is omitted              |
| `run watch [<id>]` | block until terminal; `--failfast`, `--sha`, `--timeout`                          |
| `run trigger`      | start a run; `--branch`, `--parameter key=value` (repeatable)                     |
| `run cancel <id>`  | cancel a run; **prompts unless `--force`**                                        |
| `run open`         | the project's runs page in a browser                                              |

## Workflows and jobs

| Command                            | Does                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `workflow list` (`ls`)             | workflows for a run, or for recent runs when no run is given      |
| `workflow get <id>`                | one workflow and its jobs                                         |
| `workflow rerun <id>`              | rerun all jobs, or `--from-failed`; returns the new `workflow_id` |
| `workflow cancel <id>`             | cancel a workflow; **prompts unless `--force`**                   |
| `workflow open`                    | the workflow page in a browser                                    |
| `job get <id>`                     | a job and its step table with exit codes and timings              |
| `job output list <id>`             | every step with its output; `--tail`, `--execution`, `--json`     |
| `job output get <id> --step-num N` | one step's output; `--condensed`, `--strip-ansi`                  |
| `job artifact <id>`                | list or `--output <dir>` download artifacts                       |
| `job resource-usage get <id>`      | CPU/memory against resource class limits; `--chart`               |
| `job open`                         | the job page in a browser                                         |
| `artifact <id>`                    | alias of `job artifact`                                           |

## Tests

| Command                          | Does                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| `testresult list <job-id>`       | failed tests by default; `--all`, `--filter k=v`, `--sort`, `--limit` |
| `testresult get <job-id> <name>` | one test by exact name; `--filter classname=`, `--plain`              |

## Config — see [CONFIG.md](CONFIG.md)

| Command                   | Does                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `config validate [path]`  | is this config legal; `--json` gives `valid`, `compiled_yaml`, `errors` |
| `config process [path]`   | the fully expanded YAML: orbs inlined, matrices and parameters resolved |
| `config pack <dir>`       | merge a split config directory into one document                        |
| `config generate [path]`  | scan a repo and write a starter config; never overwrites                |
| `env subst [string]`      | POSIX `envsubst` for a string or stdin; unset vars become empty         |
| `config` with `-` as path | read the config from stdin                                              |

## Orbs

| Command                                                                    | Does                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `orb validate [path]`                                                      | validate orb YAML; **exit 7** when invalid                                   |
| `orb process [path]`                                                       | validated, expanded orb YAML                                                 |
| `orb pack <dir>`                                                           | pack a multi-file orb directory                                              |
| `orb list [<namespace>]`                                                   | certified orbs globally, or one namespace's                                  |
| `orb get <ns>/<orb>`                                                       | orb metadata and statistics                                                  |
| `orb source <ns>/<orb>`                                                    | an orb version's YAML source                                                 |
| `orb diff <ns>/<orb> --from v1 --to v2`                                    | unified diff between two versions                                            |
| `orb init [path]`                                                          | scaffold an orb project; `--org`, `--remote`, `--private`, `--template-only` |
| `orb create <ns>/<orb>`                                                    | reserve a name; `--private`                                                  |
| `orb publish increment <path> <ns>/<orb> --bump major\|minor\|patch`       | publish a new **stable** version                                             |
| `orb publish promote <ns>/<orb>@dev:<label> --bump ...`                    | promote a dev version to stable                                              |
| `orb unlist <ns>/<orb>`                                                    | hide or restore an orb in the registry                                       |
| `orb add-to-category` / `orb remove-from-category` / `orb list-categories` | registry curation                                                            |
| `namespace create\|get\|rename\|delete`                                    | orb namespaces; `delete` removes every orb inside                            |

## Policy (Rego)

| Command                           | Does                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `policy eval <path>`              | run a raw OPA query locally                                   |
| `policy test <path>`              | run policy tests; append `/...` to recurse                    |
| `policy decide --input <config>`  | evaluate a config against the **remote** bundle               |
| `policy diff <path> --org <slug>` | local versus remote bundle                                    |
| `policy fetch --org <slug>`       | download the remote bundle                                    |
| `policy push <path> --org <slug>` | **replace** the remote bundle with a local directory          |
| `policy logs`                     | policy decision logs                                          |
| `policy settings get\|set`        | enforcement settings; `--policy-context` defaults to `config` |

## Pipelines and triggers

| Command                                              | Does                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pipeline list`                                      | pipeline definitions; `--json`, `--project-id`                                      |
| `pipeline run`                                       | trigger a definition; needs `--definition-id`, `--branch` or `--tag`, `--param`     |
| `pipeline create`                                    | create a definition: where the config lives, what to check out                      |
| `project trigger create`                             | attach an event source to a definition; `--provider`, `--event-preset`, `--repo-id` |
| `project trigger list --pipeline-definition-id <id>` | triggers on a definition                                                            |
| `triggers <source> <preset>`                         | the generated trigger commands, by provider and event preset                        |

`circleci help triggers` explains each provider (`github_app`,
`github_server`, `github_oauth`, `webhook`, `schedule`) and each event preset.

## Projects, orgs, settings — see [PLATFORM.md](PLATFORM.md)

| Command                              | Does                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `project list` (`ls`)                | followed projects; **the ground truth for slugs**                   |
| `project get`                        | one project's details                                               |
| `project follow`                     | enable builds for a repo                                            |
| `project link`                       | pin the project in `.circleci/info.yml`; `--force` overwrites       |
| `project create [name] --org <slug>` | create a project                                                    |
| `project setting list\|get\|set`     | advanced project settings                                           |
| `project dlc purge` / `dlc purge`    | drop the Docker layer cache; `--force`                              |
| `org list`                           | organizations you belong to                                         |
| `org setting list\|get\|set`         | advanced org settings                                               |
| `setting list\|set\|unset`           | CLI settings: `token`, `host`, `telemetry`, `theme`, `update-check` |
| `my runs`                            | your runs across every project; `--limit`                           |
| `auth me\|login\|logout\|signup\|id` | identity; `login` is a human browser step                           |

## Secrets

| Command                              | Does                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| `envvar list\|set\|delete`           | project environment variables; values masked           |
| `project envvar list\|set\|delete`   | same, inside the project group                         |
| `context list\|create\|get\|delete`  | org-scoped contexts; `--org`                           |
| `context secret list\|set\|delete`   | context variables; `--name`, `--value`                 |
| `context restriction create\|delete` | limit a context to `project`, `expression`, or `group` |
| `context open`                       | the contexts settings page                             |

## Runners

| Command                                      | Does                                         |
| -------------------------------------------- | -------------------------------------------- |
| `runner resource-class list\|create\|delete` | `<org>/<name>`; `create --generate-token`    |
| `runner token list\|create\|delete`          | runner registration tokens — **credentials** |
| `runner instance list`                       | registered runner instances                  |
| `runner config`                              | generate a runner agent config file          |
| `runner open`                                | the runners inventory page                   |

## Deploys

| Command                           | Does                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `deploy list` (`ls`)              | recent deploys; `component_name`, `version`, `status`, `is_rollback`     |
| `deploy init`                     | add deploy markers to deploy-like jobs; **idempotent**, edits the config |
| `deploy settings`                 | deploy settings for a project                                            |
| `deploy rollback <version>`       | roll back; needs `--component`, `--environment`, `--force`               |
| `deploy component list\|get`      | deploy components                                                        |
| `deploy environment list\|get`    | deploy environments                                                      |
| `deploy version list <component>` | versions of a component                                                  |
| `component-version list`          | versions of a deploy component                                           |
| `deploy open`                     | the deploys page                                                         |

## Agent surfaces

| Command                                            | Does                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `run get --failure-report`                         | condensed failed-step output for a run, one call            |
| `job output get --condensed`                       | one step, error-relevant lines only, filtered server-side   |
| `mcp start`                                        | stdio MCP server exposing the CLI to an AI client           |
| `mcp stream --port 8080`                           | HTTP MCP server                                             |
| `mcp tools`                                        | write the tool manifest to `mcp-tools.json`                 |
| `mcp claude\|cursor\|vscode enable\|disable\|list` | wire it into a desktop client                               |
| `api <path>`                                       | raw REST call with the token attached; `/api/v3` by default |

## iOS signing

| Command                               | Does                                      |
| ------------------------------------- | ----------------------------------------- |
| `certificate list\|upload\|delete`    | iOS code-signing `.p12` certificates      |
| `signing-config list\|create\|delete` | iOS signing configs                       |
| `signing-config profile add\|remove`  | provisioning profiles on a signing config |

## Help topics — read these, they are dense and current

| Topic                           | Contents                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| `circleci help getting-started` | install, authenticate, first run, MCP setup                        |
| `circleci help formatting`      | how `--json` and `--jq` combine — **partly stale**, see `SKILL.md` |
| `circleci help environment`     | every environment variable, and which setting it overrides         |
| `circleci help reference`       | **every** command's help in one document                           |
| `circleci help triggers`        | event source providers and event presets                           |
| `circleci help telemetry`       | what is collected and how to opt out                               |

## Odds and ends

| Command                                 | Does                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `completion install\|uninstall <shell>` | shell completions, written into your shell profile                              |
| `extension install\|remove`             | CLI extensions; `testsuite` is the official one and is not installed by default |
| `version`                               | version information                                                             |
| `--debug`                               | debug logging on any command                                                    |
| `-q, --quiet`                           | suppress informational output; stdout data is unaffected                        |
| `--no-color`                            | no ANSI, same as `NO_COLOR`                                                     |
