---
name: pr
description: "Author, create, or revise a pull request using Markdown and the native gh CLI."
---

# Pull requests

1. **Scope:** use the requested base, else the remote default. Fetch it and inspect
   the shipping diff against its merge-base. Keep unrelated working-tree edits out;
   commit/push only when authorized. Describe shipped changes, not pending plans.
2. **Evidence:** follow [the completion gate](../../../AGENTS.md#completion-gate).
   Reuse passing checks for unchanged code. Record exact commands and observed
   results; report failures or unavailable checks as blockers, never as passes.
3. **Diff summary:** run `git diff --shortstat <base>...HEAD` for the final pushed
   commit. Populate the template's `diff` block with those file/addition/deletion
   counts; GitHub highlights `+` additions green and `-` removals red.
4. **Body:** follow the [template](../../../.github/PULL_REQUEST_TEMPLATE.md).
   Explain the change, verification, and relevant risks/rollback. Add manual QA
   with expected outcomes only when useful. Record the actual agent tool and exact
   model identifier from the active session; list each known tool/model pair when
   several contributed. Mark unavailable identities explicitly rather than guessing
   or using a generic AI-assistance footer.
5. **Submit only when asked:** require passing checks and an authorized pushed
   branch. Check `gh pr list --head <branch>` first. For a new PR:

   ```bash
   gh pr create --base <base> --head <branch> --title '<type>(<scope>): <change>' --body-file /tmp/pr.md
   ```

   For an existing PR, use `gh pr edit <number> --body-file /tmp/pr.md`; update the
   title with `--title` when needed. Never create a duplicate, push directly to
   `master`/`main`, or merge the PR yourself.

Done: the body matches the final shipping diff and observed evidence, every
template placeholder is resolved, and attribution names the observed tool/model.
Unrelated edits remain untouched; one PR represents the branch when requested.

## Credit

Adapted from Matt Pocock's
[`pr` skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md).
