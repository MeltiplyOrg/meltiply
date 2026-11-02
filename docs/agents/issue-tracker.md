# Issue tracker: GitHub

Issues and specs live as GitHub issues. Use the `gh` CLI; it infers the repository from
`git remote -v` when run inside a clone.

## Conventions

- **Create**: `gh issue create --title "..." --body "..."` — use a heredoc for
  multi-line bodies.
- **Read**: `gh issue view <number> --comments`.
- **List**: `gh issue list --state open --json number,title,body,labels,comments`.
- **Comment**: `gh issue comment <number> --body "..."`.
- **Label**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

When a skill says "publish to the issue tracker", create an issue. When it says "fetch
the relevant ticket", run `gh issue view <number> --comments`.

## Labels

Only `ready-for-agent` and `wontfix` exist; see
[triage labels](triage-labels.md). Add a label to the tracker before a skill depends
on it.

## Pull requests are not a request surface

External PRs are not triaged as feature requests. GitHub shares one number space
across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and
fall back to `gh issue view 42`. Author PRs with the [pr skill](../../.agents/skills/pr/SKILL.md).
