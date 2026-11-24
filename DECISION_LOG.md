# Untangling decisions

The goal is behavior-preserving structural cleanup with selective anti-slop checks.
Comments and test-quality cleanup are included. Tests remain the regression safety
net until the structural changes are verified.

## Problem list and fixes

- Keep guardrails in the existing Vite+ lint path. Enable reviewed rules rather
  than importing overlapping presets. Verify diagnostics through the actual linter.
  - `vite.config.ts` enables strict types but not floating-promise checks or
    accumulating-spread checks. These mistakes can pass the current gate.
  - `lint/codebase-plugin.mjs` only rejects adjacent `as unknown as` assertions.
    Angle-bracket and other assertion chains bypass the same policy.
  - Test isolation, conditional assertions, and strict MSW setup rely on convention
    rather than an executable policy.
  - The researched Cloudflare preset requires a newer toolchain. Installing it
    here would tie this cleanup to an unrelated upgrade.
  - Status: pending implementation and hosted diagnostic review.

- Control polling time and wait for request completion instead of guessing delays.
  Preserve the same observable cache and refresh assertions.
  - `frontend/app/src/lib/browser-cache.test.tsx` waits real polling intervals
    inside `act` and raises the test budget to accommodate them.
  - `frontend/app/e2e/cache-smoke.mjs` sleeps before refreshing an analytics cohort
    and polls request counters rather than awaiting the requests.
  - `frontend/app/e2e/posts-composer.spec.ts` polls a mutation recorder even though
    the mutation has an observable response.
  - Status: pending implementation and focused browser-cache tests.

- Make `@meltiply/domain` the owner of Platform recognition. Migrate callers and
  delete the duplicate reporting export rather than retaining an alias.
  - `packages/reporting/src/contracts.ts` implements a second `isPlatform` guard.
  - API reporting and automation usage callers import that duplicate guard.
  - `workers/api/src/validation.ts` and
    `workers/automation/src/channel-revocation.ts` repeat membership checks and
    assert the result back to `Platform` instead of using the existing guard.
  - Status: pending implementation and package/Worker regression tests.

- Preserve account-analytics infrastructure failures on the job error channel.
  Keep per-account failure counts for partial Provider failures.
  - `workers/automation/src/account-analytics.ts` catches a failed candidate query
    and returns the same empty success result as a sweep with no eligible accounts.
  - The scheduler cannot distinguish a database failure from successful work.
  - Status: pending implementation and failure-path regression test.

- Represent a Post row's caption as a string. Keep attachment metadata in the
  existing attachment projection and remove unused preview-image allocations.
  - `frontend/app/src/components/posts/post-row.ts` builds a single-element
    `PostContentItem[]` with preview images that no consumer reads.
  - `frontend/app/src/components/posts/posts-helpers.ts` only reads the first
    item's caption. `PostDetailItem` exposes more states than the UI supports.
  - Status: pending implementation and row/calendar regression tests.

- Give composer attachment-ownership persistence an explicit failure outcome.
  Only successful writes count as persisted; failed writes remain recoverable.
  - `frontend/app/src/components/composer/composer.tsx` marks asset IDs as
    persisted before an asynchronous write and discards its rejection.
  - `useUpdatePost` does not own error presentation for this caller.
  - Status: pending implementation and composer recovery regression test.

- Use the active application language for invitation expiry dates.
  - `frontend/app/src/app/(dashboard)/settings/page.tsx` formats these dates with
    the browser locale while other settings tables use the selected language.
  - Status: pending implementation and settings regression test.

- Remove implementation-restating comments and review tests after the structural
  fixes. Keep tests that distinguish a real regression from an internal rename.
  - The duplicate reporting guard has a comment that becomes obsolete with its
    removal. Other candidate comments and tests require individual review.
  - Status: pending final cleanup. No test is selected for deletion without
    evidence that it cannot catch a regression.

## Required special cases and rejected changes

- Keep bounded Provider retries, queue backoff, idempotency, and DLQ behavior.
  They implement external delivery constraints, not accidental coupling.
- Keep optional telemetry best-effort and stream-cancellation cleanup that
  preserves an original failure. A discarded user mutation is different.
- Keep distinct cryptographic encodings owned by OAuth, storage signing, and
  token encryption. Similar byte conversion alone does not establish that these
  wire protocols change together.
- Keep workspace UI projections where they derive display fallbacks, connection
  availability, or pre-workspace authentication state. Replacing them wholesale
  with HTTP response types would move those decisions into consumers.
- Keep Provider editor draft state separate from submitted options where the
  editor represents incomplete input. Investigate unused members independently.
- Keep API Promise-facing Effect adapters. The Effect guidance explicitly
  sanctions those adapters; automation and state already have their own runners.
- Keep Provider acceptance validation at its current owning factory. Passing
  flags through a deployment adapter is not another policy implementation.
- Keep the composer's ancestor container query. The shared element establishes
  a container for descendants and queries its own ancestor.
- Keep integration budgets and deliberate performance-test latency injection.
  Do not enable a blanket retry/timeout ban or a global test-double ban.
- The settings route is live through `components/layout/workspace-settings.tsx`.
  The suggested orphan-route deletion is rejected.

## Verification and boundaries

Public HTTP, queue, Worker, and persisted data contracts remain unchanged. Existing
migrations and generated contracts are not cleanup targets. Existing untracked
`.audit/`, `docs/research/`, and `temp.save` are not part of this change.

The baseline is `4f25fb862083cd1cc1b3e873d5c23c3087958846`.
[Baseline CI](https://github.com/MeltiplyOrg/meltiply/actions/runs/45011176944)
passed frontend and tooling jobs but failed secret scanning, spelling, and
self-hosted smoke. It is not a green baseline.

Verification runs on GitHub-hosted runners. Rule tests must exercise positive and
negative diagnostics. The cross-cutting completion gate is `bun run
cloudflare:check`; focused tests run first. Compiler success alone does not prove
behavior preservation.

The initial inventory sampled each major area and traced the findings above.
Large frontend and Worker modules have coverage gaps. The tooling scout did not
return a usable final report. Follow-up review remains required; this log does not
claim the entire repository has no other worthwhile issues.
