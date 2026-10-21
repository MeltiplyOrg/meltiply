# Agent skills

`.agents/skills/` holds the skills agents load in this repository. Most are
vendored from their upstream projects; a subset is synchronized from the
[Essential Kit skills pack](https://github.com/Essential-kit/skills).

## Pack-managed skills

These skills are installed from `Essential-kit/skills` at the ref pinned in
[`scripts/skills/sync.mjs`](../../scripts/skills/sync.mjs) and recorded in
[`skills-lock.json`](../../skills-lock.json):

- `code-review`
- `codebase-design`
- `diagnosing-bugs`
- `domain-modeling`
- `grill-with-docs`
- `grilling`
- `handoff`
- `implement`
- `implement-spec`
- `improve-codebase-architecture`
- `research`
- `tdd`
- `to-spec`
- `to-tickets`
- `writing-for-agents`

Run these from the repository root:

```bash
bun run skills:sync   # install or update the pinned pack
bun run skills:check  # verify committed skills and lock without writing
```

The sync installs for the OpenCode agent into `.agents/skills/`, so the existing
`.claude/skills` and `.kiro/skills` symlinks see the same files. It then reapplies
this repository's domain-document names: the pack reads `GLOSSARY.md`,
`GLOSSARY-MAP.md`, and `GLOSSARY-FORMAT.md`, while this repository keeps
`CONTEXT.md`, `CONTEXT-MAP.md`, and `CONTEXT-FORMAT.md`.

## Repository-owned skill

`pr` is not pack-managed. It follows the
[completion gate](../../AGENTS.md#completion-gate) and
[PR template](../../.github/PULL_REQUEST_TEMPLATE.md), so its content belongs to
this repository. Keep it out of `managedSkills`.

The remaining skills under `.agents/skills/` are vendored from their upstreams
and are not changed by the sync. See
[third-party notices](../../THIRD_PARTY_NOTICES.md).

## Updating the pack

1. Change `packRef` in [`scripts/skills/sync.mjs`](../../scripts/skills/sync.mjs)
   to the new commit in `Essential-kit/skills`.
2. Run `bun run skills:sync`.
3. Review the skill and lock diff; upstream may add, rename, or remove skills.
4. Run `bun run skills:check`.

When the pack adds a skill, add it to `managedSkills` and to the list above. If
the pack changes its domain-document names, update `contextNames` in the sync
script and the vocabulary here.
