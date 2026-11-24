# Untangling decisions

The goal is behavior-preserving structural cleanup with selective anti-slop checks.
Comments and test-quality cleanup are included. Problems below describe the
baseline; the fixes describe the current ownership.

## Problem list and fixes

- Keep guardrails in the existing Vite+ lint path. Enable reviewed rules rather
  than importing overlapping presets. Verify diagnostics through the actual linter.
  - `vite.config.ts` enables strict types but not floating-promise checks or
    accumulating-spread checks. These mistakes can pass the current gate.
  - `lint/codebase-plugin.mjs` only rejects adjacent `as unknown as` assertions.
    Angle-bracket and other assertion chains bypass the same policy.
  - Abort-signal isolation and strict MSW setup rely on convention rather than
    an executable policy.
  - The researched Cloudflare preset requires a newer toolchain. Installing it
    here would tie this cleanup to an unrelated upgrade.
  - The first-principles review found that landmines exempts a whole test file
    when any fake-timer call appears. Date-only mocking can therefore hide a
    real Promise sleep in another test.
  - Add a focused raw-timer Promise guard for the cache tests. Exercise each
    configured rule through real positive and negative Vite+ diagnostics.

- Scope spelling vocabulary to its owning localization tests and regenerate managed
  skills from the pinned pack rather than changing the checker or pin.
  - The English spelling checker rejects the German month names asserted by two
    localization regressions. Keep those assertions and recognize each month only
    in its owning test file.
  - Several pack-managed skills are missing or differ from the pinned source.
    Restore them through `skills:sync`, retaining repository-owned adaptations.
  - Include managed-skill verification in the focused guardrail lane.
  - The history scanner reports only a finding count. Enable redacted finding
    details so the source, rule, and commit can be investigated without exposing
    the matched credential.

- Control polling time and wait for request completion instead of guessing delays.
  Preserve the same observable cache and refresh assertions.
  - `frontend/app/src/lib/browser-cache.test.tsx` waits real polling intervals
    inside `act` and raises the test budget to accommodate them.
  - `frontend/app/e2e/cache-smoke.mjs` sleeps before refreshing an analytics cohort
    and polls request counters rather than awaiting the requests.
  - `frontend/app/e2e/posts-composer.spec.ts` polls a mutation recorder even though
    the mutation has an observable response.
  - Register capability completion before the Channels action that starts its
    request. Waiting on Posts for a request only Channels makes blocks the action
    that can satisfy the wait.

- Make `@meltiply/domain` the owner of Platform recognition. Migrate callers and
  delete the duplicate reporting export rather than retaining an alias.
  - `packages/reporting/src/contracts.ts` implements a second `isPlatform` guard.
  - API reporting and automation usage callers import that duplicate guard.
  - `workers/api/src/validation.ts` and
    `workers/automation/src/channel-revocation.ts` repeat membership checks and
    assert the result back to `Platform` instead of using the existing guard.

- Preserve account-analytics infrastructure failures on the job error channel.
  Keep per-account failure counts for partial Provider failures.
  - `workers/automation/src/account-analytics.ts` catches a failed candidate query
    and returns the same empty success result as a sweep with no eligible accounts.
  - The scheduler cannot distinguish a database failure from successful work.

- Represent a Post row's caption as a string. Keep attachment metadata in the
  existing attachment projection and remove unused preview-image allocations.
  - `frontend/app/src/components/posts/post-row.ts` builds a single-element
    `PostContentItem[]` with preview images that no consumer reads.
  - `frontend/app/src/components/posts/posts-helpers.ts` only reads the first
    item's caption. `PostDetailItem` exposes more states than the UI supports.
  - `frontend/app/src/api/types.ts` also retains unread posting-time, additional
    settings, and YouTube thumbnail members. The thumbnail member is the last
    reference to the unused `MediaItem` type.

- Queue composer attachment-ownership writes and make explicit Save follow that
  queue. Show failures through the existing form state rather than silently
  discarding them or blindly repeating writes.
  - `frontend/app/src/components/composer/composer.tsx` marks asset IDs as
    persisted before an asynchronous write and discards its rejection.
  - `useUpdatePost` does not own error presentation for this caller.
  - A late ownership rejection can mark a newer successful Save as failed.
    Suppressing that message alone would still permit older writes to overwrite
    newer attachment state. One composer-owned queue orders the actual writes.

- Use the active application language for invitation expiry dates.
  - `frontend/app/src/app/(dashboard)/settings/page.tsx` formats these dates with
    the browser locale while other settings tables use the selected language.

- Give runtime acceptance its own disposable database fixture after integration.
  - `test:integration` leaves signing keys encrypted with its fixture secret in
    the shared local database. The development runtime uses a separately
    generated local secret; the combined cache lane then fails token minting.
  - The fresh-database control reaches token minting successfully. Keep phase
    isolation in the hosted workflow, not a key-deletion workaround in auth or
    an unsafe database reset inside the reusable local smoke script.

- Derive media job deadlines from container lifetime, not signed-URL lifetime.
  - `workers/automation/src/asset-processing.ts` sends 840 seconds because it
    derives the deadline from the longer-lived storage capabilities. The engine
    protocol accepts only 5 through 540 seconds and rejects every such job.
  - Use the existing container timeout with completion headroom. Keep storage
    URL expiry separate so transfers remain authorized through job completion.
  - Assert the actual emitted deadline is within the engine's accepted range in
    the existing staged-upload integration test.

- Name the channel-caption field in its browser regression.
  - The Threads editor has multiple textboxes. An unnamed textbox locator fails
    without a product regression and never reaches the save assertion.

- Remove implementation-restating comments and review tests after the structural
  fixes. Keep tests that distinguish a real regression from an internal rename.
  - Remove the obsolete doc comment with the duplicate reporting guard. The
    comment review found no other redundant comments in the delivered changes.
  - Keep the reviewed regression tests. Fix async test callbacks and middleware
    setup so tests assert behavior rather than incidental synchronous execution.

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
- Do not enable the evaluated conditional-assertion and imported-mutation rules.
  The hosted probe missed an aliased test callback and flagged legitimate
  contract branches and RuleTester setup. Keep these reviews semantic rather
  than adding repository-wide allowances for those heuristics.
- Apply typed promise checks to TypeScript. JavaScript Node test registration
  returns promises owned by the test runner; linting them as application work
  creates diagnostics without identifying unhandled application failures.
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

Verification runs on GitHub-hosted runners.
[The focused gate](https://github.com/MeltiplyOrg/meltiply/actions/runs/45383733441)
passes real positive and negative Vite+ diagnostics for every added rule, strict
lint, cache and composer regressions, row projections, selected-language dates,
account-analytics failures, channel revocation, and documentation checks.

The cross-cutting `bun run cloudflare:check` and real workerd cache/browser
acceptance [pass](https://github.com/MeltiplyOrg/meltiply/actions/runs/45386271865).
The cache smoke exercises both palettes at desktop and phone widths. Managed skills
are regenerated from the pinned pack and checked in the focused guardrail lane. The
[fresh-fixture control](https://github.com/MeltiplyOrg/meltiply/actions/runs/45385273363)
separates fixture contamination from the corrected capability wait.
The full application gate, React diagnostics command, and composer save,
recovery, detach, ordered-attachment reopening, Provider-options, and blank-caption
scenarios [pass without retries](https://github.com/MeltiplyOrg/meltiply/actions/runs/45401216968).

Independent reviews traced the delivered fixes and identified the late-write and
fake-timer bypass problems addressed above. The final targeted reviews found no
further actionable defect. Review coverage remains sampled across large frontend,
Worker, and tooling modules; this is not a claim that the entire repository has
no other worthwhile issues.

The latest completed self-hosted image smoke passes on both architectures.
Full-history secret detection and its live canary remain enabled. No failing rule,
test, or CI check is disabled to make this change pass.
