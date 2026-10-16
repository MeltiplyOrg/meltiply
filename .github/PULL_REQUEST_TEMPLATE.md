<!--
PR bodies are not handwritten Markdown here. They are authored as structured
JSON, checked, and rendered by the repo's PR-body CLI.

Copy the sample manifest:
  .github/pr.example.json    — replace the provenance placeholders (tool/model);
                               replace the added/removed diff with actual changes;
                               other sections may be blank when there is nothing to say.
                               Schema: scripts/gh-guard/pr.schema.json
                               Markdown rules: scripts/gh-guard/pr-body.mjs

Validate and preview:

  bun run pr:check  /tmp/pr-body.json   # schema + change diff + diagram + format + typo checks
  bun run pr:render /tmp/pr-body.json   # renders the Markdown body to stdout

Create the PR through the guarded gh (validates, renders, injects title/body):

  scripts/gh-guard/gh pr create --body-json /tmp/pr-body.json --base <base> --head <branch>

The explicit wrapper works without PATH activation; `gh` is shorthand only
when it resolves to this wrapper.

`--body`, `--body-file`, `--title`, `--fill`, and interactive creation are
blocked on `gh pr create` — the JSON manifest is the only way in.

AI agents: use the `pr` skill (`.agents/skills/pr/SKILL.md`) for the
section-by-section writing guidance and submission workflow.
-->
