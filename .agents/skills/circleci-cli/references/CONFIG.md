# Config, orbs, and policy

Working on the pipeline definition itself: validating it, understanding what
CircleCI actually compiles it into, splitting it across files, publishing orbs,
and running Rego policy.

The repo's own `.circleci/config.yml` is the source of truth for what this
project declares. Read it before composing any of the commands here — several
projects use `setup: true` with a continuation pipeline, which changes what a
config file is allowed to contain.

## Validate and compile

```bash
circleci config validate                    # .circleci/config.yml by default
circleci config validate path/to/config.yml
circleci config validate -                  # read from stdin
circleci config validate --org gh/myorg     # resolve private orbs
circleci config process .circleci/config.yml
```

**`validate` answers "is this legal?"** It returns the compiled YAML on success
and compilation messages on failure. `process` answers the different question
"what does CircleCI actually execute?" — it prints the fully expanded YAML with
orbs inlined, matrices expanded, and parameters resolved. Use `process` when the
config is valid but a run behaved unexpectedly; the compiled output shows the
values that were really in play.

```bash
circleci config validate --json | jq '{valid, errors}'
circleci config process .circleci/config.yml | head -40
```

`config validate --json` gives `valid` (bool), `compiled_yaml` (string, when
valid) and `errors` (array of compilation messages, when invalid) — a reliable
programmatic gate:

```bash
circleci config validate --json | jq -e .valid >/dev/null || exit 1
```

Neither needs an API token. Without one, only **public** orbs resolve; private
and namespaced orbs need a token and resolve against your org, taken from
`--org`, a `circleci project link` binding, or the git remote, in that order. A
config that fails locally but is obviously correct is usually a private orb
that could not be fetched.

`--pipeline-parameters` supplies pipeline parameters at compile time, as a YAML
map or a path to a YAML file — the way to test a parameterised config without
triggering a run:

```bash
circleci config process .circleci/config.yml --pipeline-parameters 'env: staging'
```

`-n/--next` previews breaking config changes without applying them.

## Split configs

`config pack` merges a split config directory into the single document
CircleCI accepts, on stdout.

```bash
circleci config pack .circleci
circleci config pack .circleci | circleci config validate --config -
circleci config pack src/ci
```

The directory structure maps to YAML keys: `.circleci/config.yml` merges at the
top level, and `.circleci/jobs/build.yml` becomes `jobs.build`. A file whose
name starts with `@` merges at the current level instead of nesting under a key.

Validate the packed result, not the fragments — a split config that is valid
file-by-file can still be invalid merged.

## Generate a starter config

```bash
circleci config generate            # scan the current directory
circleci config generate ./my-app
```

Detects the language stack, container image, and setup commands, then writes
`.circleci/config.yml`. If nothing supported is detected it writes a minimal
`cimg/base:stable` template with a placeholder build step rather than failing.

It **never overwrites**: if a config already exists it prints a confirmation and
exits successfully. Re-running is a safe no-op.

## Substitute variables into a config

```bash
circleci env subst "Base URL: $API_URL"
echo '{"token": "$TOKEN"}' | circleci env subst
circleci env subst < config.template.yml > config.yml
```

`env subst` substitutes `$VAR` and `${VAR}` in a string or on stdin. It has **no
escape syntax** — a literal `$` cannot be written — and it **replaces
references to unset variables with an empty string** rather than leaving them or
erroring. Both are silent. A typo in a variable name, or a shell that did not
export the variable, produces an empty value, so a templated config can
validate and still be wrong. Check the substituted output before using it.

## Orbs

```bash
circleci orb validate orb.yml          # exits 7 when invalid
circleci orb process orb.yml           # validated, fully expanded orb YAML
circleci orb pack <dir>                # pack a split orb
circleci orb list                      # certified orbs
circleci orb list <namespace>          # orbs in a namespace
circleci orb get <namespace>/<orb>
circleci orb source <namespace>/<orb>  # the orb's source
circleci orb diff <namespace>/<orb> --from v1.2.0 --to v1.3.0
```

`validate` and `process` both accept `-` to read from stdin and need no token for
public orbs. Use them in a pre-commit or CI gate: an orb that fails to process
breaks every config that references it.

The dev/stable lifecycle is two commands:

```bash
circleci orb publish increment orb.yml <namespace>/<orb> --bump patch
circleci orb publish promote <namespace>/<orb>@dev:<label> --bump minor
```

`increment` publishes straight to a new **stable** version. `promote` takes a
**dev** version — `namespace/orb@dev:my-branch` — and promotes it to stable,
incrementing from the latest stable release. Publishing is a write to a shared
registry and is effectively irreversible; confirm the target namespace and the
bump segment with the user before running either.

Scaffolding and reservation:

```bash
circleci orb init ./my-orb --org gh/myorg --remote <git-url> --skip-git
circleci orb create <namespace>/<orb> [--private]
```

`orb init` prompts for several values; pass `--remote` and `--org` to keep it
non-interactive, or `--template-only` to just fetch the template. The namespace
must already exist — create it with `circleci namespace create <name>`.

`circleci namespace rename` changes an existing namespace, and `delete` removes
it. Both are destructive for every orb inside; treat them as human-confirmed
operations.

## Rego policy

CircleCI can gate configs with OPA/Rego policies stored as a per-org bundle.

```bash
circleci policy eval policies/                     # local, no token
circleci policy test policies/                     # local tests; add /... to recurse
circleci policy decide --input .circleci/config.yml   # evaluate against the remote bundle
circleci policy diff policies/ --org gh/myorg
circleci policy fetch --org gh/myorg
circleci policy push policies/ --org gh/myorg --no-prompt
```

`eval`, `test`, and `decide` are read-only and safe to run freely. `fetch` is a
download. **`policy push` replaces the entire remote bundle** with the local
directory's contents, so a partial local directory silently deletes remote
policies. `--org` is required for anything touching the bundle, and
`--policy-context` defaults to `config`. Pass `--no-prompt` to `push` in a
non-interactive session, and confirm with the user first.

## Editing a config safely

`config process` is the tool that makes config work verifiable. Compile the
config, diff against what is committed, and the change you are about to make is
visible before it ships:

```bash
circleci config process .circleci/config.yml > /tmp/compiled.yml
git show HEAD:.circleci/config.yml | circleci config process - > /tmp/before.yml
diff -u /tmp/before.yml /tmp/compiled.yml
```

A config edit is done when `config validate --json` reports `valid: true` **and**
`config process` shows the job and parameter values you intended. Validity alone
does not mean the pipeline does what you meant — a job that silently stopped
being required is still a valid config.
