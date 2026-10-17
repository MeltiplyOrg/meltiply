---
name: code-review
description: "Review a branch, PR, work-in-progress changes, or changes since a commit, tag, or merge-base. Run parallel Standards, Spec, and Simplification reviewers to check conventions, requirements, and opportunities to simplify or reuse existing code."
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?
- **Simplification**: can the change stay correct with less complexity, duplication, or reimplementation of existing code?

Each axis runs as a **parallel sub-agent** so they don't pollute each other's context, then this skill aggregates their findings.

Use the repository's configured Git remote to identify its issue tracker.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched from that repository's issue tracker using its CLI or API.
2. A path the user passed as an argument.
3. An existing spec file matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn the sub-agents in parallel

Dispatch Standards, Spec, and Simplification together in one batch; omit only Spec when no spec is available. All reviewers are read-only: inspect source and return findings without edits or build, lint, test, or formatter runs.

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

**Simplification sub-agent prompt** should include:

- The diff command and commit list, standards-source files, and spec path or contents when available.
- The brief: "Review the changed code for concrete, behaviour-preserving simplification and refactoring opportunities. Apply KISS (simplest sufficient design), YAGNI (only current requirements), and DRY (one source of truth for shared logic). Inspect every changed implementation and search the codebase beyond the diff for existing helpers, components, services, types, and shared modules before recommending new code or an extraction. Read candidate implementations and representative callers to verify compatible semantics, errors, effects, and module boundaries.
  - **Reuse first:** identify code that reimplements an existing capability; cite the existing symbol and path and explain how the changed code can use it.
  - **De-duplicate:** identify repeated domain logic or parallel implementations; prefer an existing canonical owner, or justify shared code with concrete current callers and the repository's ownership rules.
  - **Simplify:** identify unnecessary branches, indirection, wrappers, abstractions, configuration, and unused extension points; propose the smallest refactor or deletion that preserves required behaviour.
    Report only actionable opportunities introduced or exposed by the diff, not unrelated repository-wide cleanup. Keep abstractions proportional to current needs: visual similarity alone does not justify sharing code with different semantics or coupling independent modules. For each finding, cite changed file/lines, supporting existing code/callers, the concrete replacement or refactor, and the benefit and compatibility risks. If no compatible reuse candidate exists, state the search scope for any proposed extraction. Treat opportunities as judgement calls unless backed by a documented rule; omit style-only preferences and tooling-enforced findings. Return findings under 400 words, or explicitly report none."

### 5. Aggregate

Present the reports under `## Standards`, `## Spec`, and `## Simplification` headings, verbatim or lightly cleaned. Keep the axes separate: standards compliance, requirements coverage, and simplification are distinct judgements. When reviewers identify the same issue, keep its detail under the most relevant axis and cross-reference it from the other; count it once.

End with a one-line summary: finding counts per axis, noting a skipped Spec review, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes.

## Why three axes

A change can pass one axis while raising findings on another:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**
- Code that meets standards and requirements but duplicates an existing capability → **Standards and Spec pass, Simplification opportunity.**

Reporting them separately stops one axis from masking the other.
