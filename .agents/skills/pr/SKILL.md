---
name: pr
description: "PR: author structured PR JSON, create a pull request, or revise an existing PR."
---

# PR

Meltiply PR bodies are authored as **structured JSON**, not handwritten
Markdown. `scripts/gh-guard/pr.schema.json` owns field types;
`scripts/gh-guard/pr-body.mjs` enforces Markdown requirements. [`.github/pr.example.json`](../../../.github/pr.example.json) is the
filled sample to copy. `bun run pr:check` validates a manifest and
`bun run pr:render` emits the rendered Markdown body to stdout; submission
goes through the `gh` guard's `gh pr create --body-json`.
[`PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md) points
humans at the same machinery; this skill owns the writing and submission
guidance.

The four `sections` keys (`summary`, `evidence`, `mergeDanger`, `qa`) are required.
Summary must include the added/removed diff described below; the other sections
may be `""` when there is nothing to report. Optional `diagrams` entries map
Mermaid source to their section. The acknowledgement and tool/model footer come
from `agent` metadata. The CLI checks structure, format, and spelling; authors
remain responsible for factual changes and verification evidence.

## Workflow

### 1. Scope the diff

Resolve the base the user asked for, else the remote default —
`git symbolic-ref refs/remotes/origin/HEAD` (or
`gh repo view --json defaultBranchRef`); ask only if neither resolves. Then
`git fetch origin` and take the shipping diff against the merge-base:
`git diff origin/<base>...HEAD`.

`git status --porcelain` reveals uncommitted work. The body describes what the
branch will ship: implementation that belongs to the change but is still
uncommitted must be committed and pushed before submission — only when the
user authorizes it — and is never described as shipped while it isn't.
Unrelated user edits in the tree stay uncommitted and out of the body; never
stage or commit them to make the diff tidy.

The scope is established when you can name every file in the shipping diff
and state, for each uncommitted change, whether it ships with this PR.

### 2. Gather evidence

Evidence is what you observed, not what should happen:

- Reuse the verification already run under the
  [completion gate](../../../AGENTS.md#completion-gate) — the scoped check for
  each changed area, plus runnable proof of the changed behavior. Run missing
  pieces now; do not re-run passing checks on unchanged code.
- Record the exact command and its real outcome (exit status, key output).
- A required check that is blocked or fails is reported as a blocker —
  never presented as verified.
- For UI changes, capture before/after screenshots when the environment allows.
- Consult [`CONTEXT.md`](../../../CONTEXT.md) only for domain vocabulary: name
  concepts with the glossary's terms, not synonyms it avoids.

Evidence gathering is done when every check the completion gate requires for
the changed areas has a recorded, truthful outcome — including the ones that
failed or could not run.

### 3. Compose the JSON body

Copy `.github/pr.example.json` to a scratch path (e.g. `/tmp/pr-body.json`) and
fill it. Keep the body visual-first: the visual answers "what changed"; the
prose stays short. Section strings are Markdown rendered under a generated
top-level heading — use `###` for any subheadings inside them, close every
fence you open, and keep everything visible: HTML comments inside sections
are rejected, so nothing may hide in them.

- **summary**: one or two sentences naming the change type, concrete
  files/symbols touched, and what stays unchanged. Include a top-level
  `### Added / removed` subheading followed by a fenced `diff` block. Each
  nonblank row must start with `+ ` for an addition or `- ` for a removal,
  followed immediately by a nonempty change description. GitHub highlights
  these rows green/red. Describe actual behavior or files from the shipping
  diff, not a literal patch; use only the relevant prefix for addition-only or
  deletion-only changes. Keep it compact and never invent the opposite direction.
  A Mermaid diagram may additionally explain real relationships or state flow
  that the change list cannot show; use plain source without configuration
  directives, `click` links, HTML, or nested fences.
- **evidence**: observed before/after outcomes from step 2 — commands and
  results verbatim, screenshots for UI changes. A missing before-state says
  so honestly ("did not exist before", "crashed with …"). This is observed
  fact; manual steps the reviewer will run later belong in `qa`.
- **mergeDanger**: door — one-way or two-way — with what rollback actually
  requires (revert, migration, data cleanup); blast radius — the concrete
  affected scope: surfaces, consumers, data.
- **qa**: numbered steps a reviewer can execute, each covering setup → action
  → expected result. These are future manual actions; never repeat evidence
  here.
- **agent**: real identities only. `tool` and `version` come from the
  environment (`--version`, env vars) — version without a leading `v`; `model`
  comes from the system prompt/runtime identity. `readAgents: true` is a
  factual claim: keep it only if you have read `AGENTS.md`. If tool or model
  is unobtainable, ask the user — a guessed identity is worse than a question.

The body is composed when the JSON parses against the schema, every populated
field carries truthful content, and the metadata is real — not when the fields
are merely nonempty.

### 4. Validate

```bash
bun run pr:check /tmp/pr-body.json   # schema + change diff + diagram + format + typo checks
bun run pr:render /tmp/pr-body.json  # same checks, then Markdown body on stdout
```

`pr:check` is the gate; `pr:render` previews exactly what `gh` will submit
(redirect to a file to read it). Validation runs Mermaid's pinned parser,
Prettier, and `typos` — all already present in the development environment —
and a clean pass proves syntax and spelling, not that a diagram lays out well
on GitHub or that the evidence is true. A missing checker fails closed: fix
the environment, never bypass the check. Fix every reported violation and
re-run until clean.

### 5. Create or revise — only when asked

Submit only when requested and the required repository checks have passed.
Report blockers instead of publishing an unverified PR. From the repository root:

```bash
scripts/gh-guard/gh pr create --body-json /tmp/pr-body.json --base <base> --head <branch>
```

- Call the wrapper explicitly so creation works even without `direnv` or PATH
  activation. `gh` is equivalent only when it resolves to this wrapper.
- The PATH-shadow `gh` guard validates the JSON, renders the body, and injects
  `--title`/`--body-file`. Hand-supplied bodies (`--body`, `--body-file`,
  `--title`, `--fill`, template/editor flows) are blocked on create — the JSON
  manifest is the only way in. `--body-json -` reads stdin.
- Before creating, check whether the branch already has an open PR —
  `gh pr list --head <branch>` or `gh pr status`. If one exists, render the
  revised body to a file (`bun run pr:render /tmp/pr-body.json > /tmp/pr-body.md`)
  and update with `gh pr edit --body-file /tmp/pr-body.md` — the guard does not
  intercept `pr edit`, so render through the validated JSON, never write the
  Markdown by hand.
- Never push to `master`/`main`; never merge the PR.

Done criteria, end to end: the shipping diff is established without touching
unrelated changes; every required repository check passes; the JSON passes
`pr:check` with truthful content and real metadata; and — if requested — exactly
one PR exists for the branch with that validated body.

## Credit

Adapted from Matt Pocock's
[`pr` skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md).
