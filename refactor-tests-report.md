# Test suite refactor report

## Status

**The goal is not met.** Four packages are rewritten in whole or in part; most of the suite is unchanged.

Rewritten to the pure-function rules: `packages/domain`, `packages/secrets`, `packages/reporting` (policy, configuration, diagnostics, sanitize) and the `packages/providers` helpers (rate-limit, failures, results, values). The reporting capture transport moved to a fake `fetch`. Five integration files had their database URLs fixed and are otherwise unchanged.

| Done condition                  | State                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Written to the rules            | Met only for the files named above. 185 of the original 197 files are not rewritten.                                                                  |
| Every case covered              | Met only for the functions in those files. No case lists were written for the rest, and for the rewritten modules the `it` names are the only record. |
| Every cost within the scale     | Not met. See [Over budget](#over-budget).                                                                                                             |
| Every test at the fastest level | Not met. No push-down verdicts exist for the unchanged route, service, round-trip, web component or browser tests.                                    |

### What blocks the service, route and round-trip rules

- **No repository layer.** SQL is written inline in 49 source files and there is no repository class or interface. Typed fakes and repository round trips need a data layer extracted from both Workers, including its locking.
- **Outside services are not configurable by URL.** Provider API origins are constants in `packages/providers`; only the PostHog host is an environment setting. Black-box route tests need new URL settings in the app, which is a new capability and not a refactor.
- **Size.** The unchanged files hold most of the original 88,000 lines.

### Not rewritten

- `packages/providers`: adapters, `validator`, `http`, `effect`, `index`. `oauth`, `meta` and `limits` have no test module of their own.
- `packages/reporting`: `service`, `usage` and the guards in `contracts` have no direct tests.
- `packages/auth`, `contracts`, `database`, `observability`, `storage`: unchanged.
- `workers/api`, `workers/automation`, `workers/state`, `frontend/app`: unchanged apart from the five URL fixes.

## How it was run

- Bun replaces pnpm: `bun run test`, and `vp test run` for Vitest.
- Scope: TypeScript tests in `frontend/`, `packages/` and `workers/`. The vendored `.agents/` tests and the `.mjs` and `.sh` script tests are excluded.
- Base commit `43fba6a`. The machine has 4 cores and was running other jobs (load average 1.4 to 7), so treat every timing as rough.
- Test types for the tables were assigned by a heuristic over file contents, not by reading all files.
- The base integration run used a copy of the five files with the port rewritten to a disposable database.

## Suite CPU time and test count

|                                                             | Before  | After                            |
| ----------------------------------------------------------- | ------- | -------------------------------- |
| `bun run test` CPU (user + sys), back to back               | 520.1 s | 566.2 s and 553.5 s (+6% to +9%) |
| `bun run test` CPU, first baseline (load about 5)           | 575.9 s |                                  |
| `bun run test:integration` CPU, database server not counted | 64.1 s  | 61.0 s                           |
| Unit tests                                                  | 2,283   | 2,728                            |
| Integration tests                                           | 452     | 452                              |

The suite stays within the 25% limit.

## Category tables

The before and after passes ran at different machine loads. A lower time in a package that was not changed is noise, not an improvement.

### `packages/auth`

Before

| Category        | Total   | Setup  | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------ | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (real) | 1.6 sec | 437 ms | 100.0%     | 11    | 110 ms       | 50 ms  | 1           | 9.1%          |
| All             | 1.6 sec | 437 ms | 100.0%     | 11    | 110 ms       | —      | 1           | 9.1%          |

After

| Category        | Total   | Setup  | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------ | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (real) | 1.3 sec | 357 ms | 100.0%     | 11    | 86 ms        | 50 ms  | 1           | 9.1%          |
| All             | 1.3 sec | 357 ms | 100.0%     | 11    | 86 ms        | —      | 1           | 9.1%          |

### `packages/contracts`

Before

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Contract checks | 7.1 sec | 4.1 sec | 100.0%     | 23    | 132 ms       | —      | —           | —             |
| All             | 7.1 sec | 4.1 sec | 100.0%     | 23    | 132 ms       | —      | —           | —             |

After

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Contract checks | 3.5 sec | 2.0 sec | 100.0%     | 23    | 67 ms        | —      | —           | —             |
| All             | 3.5 sec | 2.0 sec | 100.0%     | 23    | 67 ms        | —      | —           | —             |

### `packages/database`

Before

| Category             | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes)     | 1.1 sec | 1.0 sec | 27.7%      | 14    | 5.5 ms       | 5 ms   | 0           | 0.0%          |
| Database round trips | 2.9 sec | 1.0 sec | 72.3%      | 25    | 74 ms        | 50 ms  | 8           | 32.0%         |
| All                  | 3.9 sec | 2.0 sec | 100.0%     | 39    | 50 ms        | —      | 8           | 20.5%         |

After

| Category             | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes)     | 504 ms  | 487 ms  | 14.6%      | 14    | 1.2 ms       | 5 ms   | 0           | 0.0%          |
| Database round trips | 3.0 sec | 1.3 sec | 85.4%      | 25    | 68 ms        | 50 ms  | 7           | 28.0%         |
| All                  | 3.5 sec | 1.7 sec | 100.0%     | 39    | 44 ms        | —      | 7           | 17.9%         |

### `packages/domain`

Before

| Category       | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions | 2.0 sec | 2.0 sec | 100.0%     | 49    | 1.4 ms       | 5 ms   | 2           | 4.1%          |
| All            | 2.0 sec | 2.0 sec | 100.0%     | 49    | 1.4 ms       | —      | 2           | 4.1%          |

After

| Category       | Total  | Setup  | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------- | ------ | ------ | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions | 986 ms | 930 ms | 100.0%     | 192   | 0.3 ms       | 5 ms   | 0           | 0.0%          |
| All            | 986 ms | 930 ms | 100.0%     | 192   | 0.3 ms       | —      | 0           | 0.0%          |

### `packages/observability`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 2.5 sec | 2.3 sec | 100.0%     | 30    | 4.2 ms       | 5 ms   | 4           | 13.3%         |
| All              | 2.5 sec | 2.3 sec | 100.0%     | 30    | 4.2 ms       | —      | 4           | 13.3%         |

After

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 1.7 sec | 1.6 sec | 100.0%     | 30    | 2.8 ms       | 5 ms   | 4           | 13.3%         |
| All              | 1.7 sec | 1.6 sec | 100.0%     | 30    | 2.8 ms       | —      | 4           | 13.3%         |

### `packages/providers`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 1.7 sec | 1.6 sec | 19.6%      | 58    | 0.9 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes) | 6.8 sec | 5.2 sec | 80.4%      | 304   | 5.3 ms       | 5 ms   | 16          | 5.3%          |
| All              | 8.5 sec | 6.9 sec | 100.0%     | 362   | 4.6 ms       | —      | 16          | 4.4%          |

After

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 1.3 sec | 1.3 sec | 21.5%      | 226   | 0.3 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes) | 4.8 sec | 3.8 sec | 78.5%      | 304   | 3.6 ms       | 5 ms   | 16          | 5.3%          |
| All              | 6.2 sec | 5.0 sec | 100.0%     | 530   | 2.2 ms       | —      | 16          | 3.0%          |

### `packages/reporting`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 1.3 sec | 1.2 sec | 73.6%      | 34    | 1.3 ms       | 5 ms   | 1           | 2.9%          |
| Services (fakes) | 457 ms  | 171 ms  | 26.4%      | 10    | 29 ms        | 5 ms   | 5           | 50.0%         |
| All              | 1.7 sec | 1.4 sec | 100.0%     | 44    | 7.5 ms       | —      | 6           | 13.6%         |

After

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 1.3 sec | 1.3 sec | 93.9%      | 153   | 0.3 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes) | 85 ms   | 77 ms   | 6.1%       | 7     | 1.1 ms       | 5 ms   | 0           | 0.0%          |
| All              | 1.4 sec | 1.3 sec | 100.0%     | 160   | 0.3 ms       | —      | 0           | 0.0%          |

### `packages/secrets`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 1.1 sec | 1.1 sec | 100.0%     | 6     | 4.7 ms       | 5 ms   | 1           | 16.7%         |
| All              | 1.1 sec | 1.1 sec | 100.0%     | 6     | 4.7 ms       | —      | 1           | 16.7%         |

After

| Category         | Total  | Setup  | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------ | ------ | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 488 ms | 465 ms | 100.0%     | 24    | 1 ms         | 5 ms   | 0           | 0.0%          |
| All              | 488 ms | 465 ms | 100.0%     | 24    | 1 ms         | —      | 0           | 0.0%          |

### `packages/storage`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 885 ms  | 860 ms  | 18.8%      | 3     | 8.3 ms       | 5 ms   | 1           | 33.3%         |
| Services (fakes) | 3.8 sec | 3.4 sec | 81.2%      | 74    | 5.3 ms       | 5 ms   | 7           | 9.5%          |
| All              | 4.7 sec | 4.3 sec | 100.0%     | 77    | 5.4 ms       | —      | 8           | 10.4%         |

After

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 401 ms  | 390 ms  | 20.3%      | 3     | 3.7 ms       | 5 ms   | 1           | 33.3%         |
| Services (fakes) | 1.6 sec | 1.4 sec | 79.7%      | 74    | 2.5 ms       | 5 ms   | 6           | 8.1%          |
| All              | 2.0 sec | 1.8 sec | 100.0%     | 77    | 2.6 ms       | —      | 7           | 9.1%          |

### `workers/api`

Before

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 4.5 sec  | 4.5 sec  | 1.8%       | 10    | 1.5 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes) | 38.6 sec | 38.2 sec | 15.1%      | 143   | 2.9 ms       | 5 ms   | 12          | 8.4%          |
| Services (real)  | 927 ms   | 624 ms   | 0.4%       | 3     | 101 ms       | 50 ms  | 3           | 100.0%        |
| Route handlers   | 3m 29sec | 2m 3sec  | 81.7%      | 515   | 168 ms       | 100 ms | 171         | 33.2%         |
| Contract checks  | 2.9 sec  | 1.5 sec  | 1.1%       | 289   | 5 ms         | —      | —           | —             |
| All              | 4m 16sec | 2m 48sec | 100.0%     | 960   | 92 ms        | —      | 186         | 27.7%         |

After

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 4.2 sec  | 4.2 sec  | 2.2%       | 10    | 1.6 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes) | 33.1 sec | 32.7 sec | 17.1%      | 143   | 2.3 ms       | 5 ms   | 11          | 7.7%          |
| Services (real)  | 673 ms   | 437 ms   | 0.3%       | 3     | 79 ms        | 50 ms  | 3           | 100.0%        |
| Route handlers   | 2m 33sec | 1m 18sec | 79.0%      | 515   | 145 ms       | 100 ms | 169         | 32.8%         |
| Contract checks  | 2.5 sec  | 1.3 sec  | 1.3%       | 289   | 4.5 ms       | —      | —           | —             |
| All              | 3m 13sec | 1m 57sec | 100.0%     | 960   | 80 ms        | —      | 183         | 27.3%         |

### `workers/automation`

Before

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 16.1 sec | 16.1 sec | 14.5%      | 13    | 2.3 ms       | 5 ms   | 1           | 7.7%          |
| Services (fakes) | 1m 14sec | 1m 13sec | 66.7%      | 168   | 5 ms         | 5 ms   | 26          | 15.5%         |
| Services (real)  | 11.7 sec | 7.0 sec  | 10.6%      | 73    | 65 ms        | 50 ms  | 34          | 46.6%         |
| Route handlers   | 9.1 sec  | 1.3 sec  | 8.2%       | 74    | 105 ms       | 100 ms | 16          | 21.6%         |
| All              | 1m 51sec | 1m 38sec | 100.0%     | 328   | 41 ms        | —      | 77          | 23.5%         |

After

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 13.5 sec | 13.5 sec | 15.1%      | 13    | 2.2 ms       | 5 ms   | 1           | 7.7%          |
| Services (fakes) | 1m 1sec  | 1m 0sec  | 67.8%      | 168   | 4.5 ms       | 5 ms   | 27          | 16.1%         |
| Services (real)  | 8.7 sec  | 5.2 sec  | 9.7%       | 73    | 49 ms        | 50 ms  | 33          | 45.2%         |
| Route handlers   | 6.6 sec  | 1.0 sec  | 7.4%       | 74    | 76 ms        | 100 ms | 15          | 20.3%         |
| All              | 1m 30sec | 1m 20sec | 100.0%     | 328   | 30 ms        | —      | 76          | 23.2%         |

### `workers/state`

Before

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (real) | 9.3 sec | 8.2 sec | 100.0%     | 19    | 57 ms        | 50 ms  | 5           | 26.3%         |
| All             | 9.3 sec | 8.2 sec | 100.0%     | 19    | 57 ms        | —      | 5           | 26.3%         |

After

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (real) | 6.9 sec | 5.9 sec | 100.0%     | 19    | 49 ms        | 50 ms  | 7           | 36.8%         |
| All             | 6.9 sec | 5.9 sec | 100.0%     | 19    | 49 ms        | —      | 7           | 36.8%         |

### `frontend/app`

Before

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 10.9 sec | 10.1 sec | 7.6%       | 312   | 2.7 ms       | 5 ms   | 14          | 4.5%          |
| Services (fakes) | 22.0 sec | 18.5 sec | 15.3%      | 94    | 37 ms        | 5 ms   | 40          | 42.6%         |
| Web components   | 1m 51sec | 56.5 sec | 77.1%      | 381   | 143 ms       | —      | —           | —             |
| All              | 2m 24sec | 1m 25sec | 100.0%     | 787   | 75 ms        | —      | 54          | 13.3%         |

After

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 9.0 sec  | 8.2 sec  | 7.3%       | 312   | 2.4 ms       | 5 ms   | 14          | 4.5%          |
| Services (fakes) | 18.6 sec | 15.4 sec | 15.1%      | 94    | 34 ms        | 5 ms   | 40          | 42.6%         |
| Web components   | 1m 36sec | 49.1 sec | 77.6%      | 381   | 122 ms       | —      | —           | —             |
| All              | 2m 3sec  | 1m 13sec | 100.0%     | 787   | 64 ms        | —      | 54          | 13.3%         |

## Tests moved or removed

Each was checked by breaking the behaviour and watching a remaining test fail.

| Test                                                            | Now                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| domain: "yields and catches tagged errors in Effect.gen"        | Removed. The tagged-error table asserts each `_tag`.                                                                     |
| domain: `code-point-length.test.ts`                             | Moved to `test/index.test.ts`.                                                                                           |
| domain: `assets.test.ts`, including its multipart property loop | `test/asset-policy.test.ts`, with literal examples at each part boundary.                                                |
| providers: `adapter-helpers.test.ts`                            | `failures.test.ts`, `results.test.ts`, `values.test.ts`. Its `codePointLength` assertions are covered by domain's table. |
| reporting: transport tests on a local HTTP server               | Same behaviours on an injected `fetch`. The redirect case now asserts `redirect: "manual"` on the request.               |
| reporting: configuration cases inside `transport.test.ts`       | `test/configuration.test.ts`.                                                                                            |

One application change: the asset upload policy moved unchanged from `packages/domain/src/index.ts` to `asset-policy.ts` and is re-exported.

## Slowest ten

### Tests before

| Time   | Test                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.4 s | `workers/api/test/query-budget.integration.test.ts` > core API PostgreSQL query budgets > holds statement and row counts constant for scaled core routes                                                             |
| 2.4 s  | `frontend/app/src/components/brand-profile-scope.test.tsx` > Posts surfaces > pages the cached grid without refetching and resets the page when filters change                                                       |
| 2.2 s  | `packages/contracts/test/examples.test.ts` > operation examples > validates request and response bodies against the dereferenced OpenAPI schemas                                                                     |
| 1.7 s  | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > accepts community uploads and processing beyond finite-policy allowances                                      |
| 1.5 s  | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > never mints a single-PUT grant past the recorded deadline when signing stalls across a cancel                 |
| 1.5 s  | `workers/api/test/better-auth.integration.test.ts` > optional authenticator lifecycle > confirms enrollment, challenges sign-in, consumes backup codes once, regenerates and disables with password reauthentication |
| 1.4 s  | `workers/api/test/core-service.integration.test.ts` > Worker core service with PostgreSQL RLS > keeps upload quota writes below the accepted local p95 latency budget                                                |
| 1.3 s  | `frontend/app/src/components/composer/composer.test.tsx` > Composer default ownership > preselects the first profile for a new Post without changing the collection filter                                           |
| 1.3 s  | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > preserves the authoritative Post when an upload, save, or schedule is rejected                                |
| 1.3 s  | `frontend/app/src/components/brand-profile-scope.test.tsx` > Channels table contract > renders focused channel controls and narrows connected channel rows with each filter                                          |

### Tests after

| Time   | Test                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.4 s | `workers/api/test/query-budget.integration.test.ts` > core API PostgreSQL query budgets > holds statement and row counts constant for scaled core routes                                                             |
| 2.0 s  | `frontend/app/src/components/brand-profile-scope.test.tsx` > Posts surfaces > pages the cached grid without refetching and resets the page when filters change                                                       |
| 1.5 s  | `workers/api/test/better-auth.integration.test.ts` > optional authenticator lifecycle > confirms enrollment, challenges sign-in, consumes backup codes once, regenerates and disables with password reauthentication |
| 1.4 s  | `workers/api/test/core-service.integration.test.ts` > Worker core service with PostgreSQL RLS > keeps upload quota writes below the accepted local p95 latency budget                                                |
| 1.4 s  | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > never mints a single-PUT grant past the recorded deadline when signing stalls across a cancel                 |
| 1.0 s  | `packages/contracts/test/examples.test.ts` > operation examples > validates request and response bodies against the dereferenced OpenAPI schemas                                                                     |
| 1.0 s  | `workers/api/test/publishing-queues.integration.test.ts` > durable publishing Queues through authenticated HTTP > freezes existing reservations across plan edits, and releases only the removed slot                |
| 993 ms | `workers/api/test/onboarding.integration.test.ts` > first-run bootstrap through the auth surface > applies the chosen Workspace name to the single canonical Workspace and resumes onboarding                        |
| 975 ms | `packages/database/test/migration-012.integration.test.ts` > multi-user role migration > preserves the existing personal Workspace and its data as the shared Workspace                                              |
| 970 ms | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > preserves the authoritative Post when an upload, save, or schedule is rejected                                |

### Files before (total, of which setup)

| Time            | File                                                               |
| --------------- | ------------------------------------------------------------------ |
| 31.0 s (30.0 s) | `workers/api/test/core-routes.test.ts`                             |
| 18.3 s (9.9 s)  | `frontend/app/src/components/composer/composer.test.tsx`           |
| 15.2 s (13.0 s) | `frontend/app/src/preview/handlers.test.ts`                        |
| 14.0 s (2.9 s)  | `frontend/app/src/components/brand-profile-scope.test.tsx`         |
| 13.4 s (1.0 s)  | `workers/api/test/query-budget.integration.test.ts`                |
| 12.6 s (1.3 s)  | `workers/api/test/device-auth.integration.test.ts`                 |
| 11.4 s (10.9 s) | `workers/api/test/app.test.ts`                                     |
| 11.2 s (802 ms) | `workers/api/test/core-service.integration.test.ts`                |
| 11.0 s (7.6 s)  | `frontend/app/src/components/composer/schedule-date-time.test.tsx` |
| 10.9 s (904 ms) | `workers/api/test/post-media-lifecycle.integration.test.ts`        |

### Files after (total, of which setup)

| Time            | File                                                               |
| --------------- | ------------------------------------------------------------------ |
| 14.5 s (7.5 s)  | `frontend/app/src/components/composer/composer.test.tsx`           |
| 13.0 s (1.2 s)  | `workers/api/test/query-budget.integration.test.ts`                |
| 13.0 s (12.4 s) | `workers/api/test/core-routes.test.ts`                             |
| 12.7 s (10.7 s) | `frontend/app/src/preview/handlers.test.ts`                        |
| 12.0 s (2.7 s)  | `frontend/app/src/components/brand-profile-scope.test.tsx`         |
| 11.0 s (796 ms) | `workers/api/test/core-service.integration.test.ts`                |
| 10.6 s (677 ms) | `workers/api/test/post-media-lifecycle.integration.test.ts`        |
| 9.6 s (6.8 s)   | `frontend/app/src/components/composer/schedule-date-time.test.tsx` |
| 9.2 s (798 ms)  | `workers/api/test/upload-quota.integration.test.ts`                |
| 8.9 s (8.6 s)   | `workers/automation/test/worker.test.ts`                           |

## Over budget

368 tests and 179 files were over budget before; 355 tests and 175 files are after. Causes are given per group. Only the Workers pool cause was confirmed by measurement; the others were not profiled test by test.

| Group                                                   | Cause                                                                                                         | Change that would fix it                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Files in `workers/*`                                    | Confirmed: in a `workers/api` run, transform and import are over 95% of the duration and tests 1 to 2%.       | Run logic tests in the Node pool and keep only binding-dependent tests in workerd. |
| Files in `frontend/app`                                 | Likely: a new jsdom environment and module graph per file.                                                    | Run non-DOM files without jsdom, and narrow barrel imports.                        |
| Files in `packages/*`                                   | Likely: Vitest process start, transform and V8 coverage per file. The 100 ms file budget is below that floor. | Fewer, larger files, or measure without coverage.                                  |
| Route and round-trip tests                              | Likely: real Postgres with several requests to arrange each case.                                             | Arrange less per test and start from a database snapshot.                          |
| Provider adapter tests                                  | Likely: first-call warm-up in a file, large generated payloads and real timeouts.                             | Warm up in `beforeAll` and inject shorter timeouts.                                |
| `facebook` "bounds pagination without discovered Pages" | Likely: it walks the whole pagination bound.                                                                  | Make the bound an argument the test lowers.                                        |

Tried and rejected: Vitest's file-system module cache fails in the Workers pool. Pre-bundling `effect` did not beat repeated baseline runs, and adding `hono` and `zod` failed 210 tests.

## Duplicates and slow tests outside the scope

No search for out-of-scope duplicates was done. The 16 Playwright specs in `frontend/app/e2e` and the `.agents/` tests were not run or timed.

## Bugs and test problems found

No product behaviour bug was found in the rewritten modules, so there are no pinned or skipped tests.

- **Fixed: tests wrote to the development database.** Five integration files hardcoded port 5433 and ignored `MELTIPLY_DATABASE_TEST_URL`. They now derive their URLs from it. The base runs made for this report did write to the local database on 5433 before this was noticed: test rows, an `ops-usage` organization and rewritten reporting preferences. All five users there are `@meltiply.local` seed accounts.
- **Flaky:** `device-auth.integration.test.ts` "counts per-device throttled polls against the caller ceiling before a new code can allocate a bucket" failed in one full integration run and passed in the others, probably a rate-limit window rolling over.
- **Order-dependent, identical on the base commit with the same seed (not fixed):**
  - `workers/automation` `worker.test.ts`: 1 test (seed 1795668468170).
  - `workers/api` integration: 2 tests (seed 1795668624083).
  - `workers/automation` integration: 11 tests (seed 1795668712487).

## Verification

| Command                                                                      | Result                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bun run format-check:cloudflare`, and `vp fmt --check` on the changed files | Pass. `bun run format` was not run in write mode over the whole repository. |
| `bun run lint`                                                               | Pass                                                                        |
| `bun run lint:dead`                                                          | Pass                                                                        |
| `vp run -r type-check`                                                       | Pass                                                                        |
| `bun run test`                                                               | Pass, twice                                                                 |
| `bun run test:integration` on a disposable database                          | Pass                                                                        |
| Shuffled, every package                                                      | Passes except the order-dependent tests above                               |
| One at a time, each of the 565 tests in the rewritten files                  | Pass                                                                        |
| One at a time, unchanged files                                               | Not run                                                                     |

Nothing was pushed, so CI has not run these changes.

## Appendix: every test over budget after

| Time   | Budget | File                                                                 | Test                                                                                                                                                                    |
| ------ | ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 755 ms | 5 ms   | `frontend/app/src/lib/upload.test.ts`                                | contract upload sessions > keeps a resumable session when a direct upload fails                                                                                         |
| 415 ms | 5 ms   | `frontend/app/src/lib/i18n.catalog.test.ts`                          | Spanish i18n catalog > covers literal translation calls, accessible attributes, and user-facing JSX text                                                                |
| 304 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > keeps first-run progress until completion and resets it with the preview                                                     |
| 300 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > exposes failed publication and expired Channel recovery states from the shared examples                                      |
| 233 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > returns empty collections without removing the authenticated workspace shell                                                 |
| 230 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > keeps draft edits local and resets them with a fresh preview                                                                 |
| 224 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > scopes exact error responses to one operation without mutating successful data                                               |
| 199 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > removes a deleted sample without losing separately created or unrelated Posts                                                |
| 199 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > allows signed-out and second-factor journeys without real authentication                                                     |
| 175 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > keeps seeded workspace identities coherent across pagination, Channels, Queues, and calendar events                          |
| 155 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > retains the database seed's ordered composition separately from its frozen publication                                       |
| 154 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > returns a usable Asset after uploading bytes so the composer can attach and poll it                                          |
| 136 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > retains independent native publishing choices across a reordered multi-Channel draft update                                  |
| 122 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > keeps one Channel's analytics history separate from other Distributions                                                      |
| 112 ms | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > rejects requests outside the contract rather than contacting an upstream                                                     |
| 99 ms  | 5 ms   | `frontend/app/src/preview/handlers.test.ts`                          | contract-driven UI preview HTTP boundary > serves the device consent preview without a backend                                                                          |
| 51 ms  | 5 ms   | `frontend/app/src/lib/copy-text.test.ts`                             | copyText > falls back to a temporary selection when Clipboard API is unavailable                                                                                        |
| 47 ms  | 5 ms   | `frontend/app/src/lib/auth-client.test.ts`                           | Better Auth JWT lifecycle > stores the get-session JWT as the bearer credential for API requests                                                                        |
| 34 ms  | 5 ms   | `frontend/app/eslint-boundaries.test.ts`                             | boundaries/no-raw-palette-utility > valid > keeps allowing the non-color shadow-md utility                                                                              |
| 33 ms  | 5 ms   | `frontend/app/src/components/devbox/network-throttle.test.ts`        | DevBox network throttle > releases requests held by infinite latency when the latency changes                                                                           |
| 31 ms  | 5 ms   | `frontend/app/src/lib/upload.test.ts`                                | contract upload sessions > uploads and completes a single-part session                                                                                                  |
| 30 ms  | 5 ms   | `frontend/app/src/lib/upload.test.ts`                                | contract upload sessions > aborts and awaits sibling parts after a fatal multipart failure                                                                              |
| 25 ms  | 5 ms   | `frontend/app/src/components/posts/calendar-slots.test.ts`           | Queue calendar slots > skips nonexistent DST slots instead of displaying false availability                                                                             |
| 24 ms  | 5 ms   | `frontend/app/src/lib/publishing-preferences.test.ts`                | publishing timezone conversion > moves a spring-forward gap forward by the missing hour                                                                                 |
| 24 ms  | 5 ms   | `frontend/app/src/components/posts/calendar-dates.test.ts`           | toCalendarRows > keeps one row per Post per civil day in the publishing timezone                                                                                        |
| 22 ms  | 5 ms   | `frontend/app/src/lib/format.test.ts`                                | postDateFormatters > reuses one formatter pair for each publishing timezone                                                                                             |
| 20 ms  | 5 ms   | `frontend/app/src/components/posts/posts-helpers.test.ts`            | formatPostDate > formats in the active language and publishing timezone                                                                                                 |
| 20 ms  | 5 ms   | `frontend/app/src/lib/theme-preference.test.ts`                      | page-only theme intent > keeps an explicit choice available for navigation without granting consent or persisting it                                                    |
| 18 ms  | 5 ms   | `frontend/app/src/lib/queries.test.ts`                               | bulk Post deletion > bounds concurrency, isolates failures, and keys each request by position                                                                           |
| 18 ms  | 5 ms   | `frontend/app/src/lib/api.test.ts`                                   | generated API client adapters > preserves the normative error envelope, request ID, and retry delay                                                                     |
| 18 ms  | 5 ms   | `frontend/app/src/lib/cookie-consent.test.ts`                        | optional cookie and storage consent > does not read or write optional preference values before a choice                                                                 |
| 16 ms  | 5 ms   | `frontend/app/src/lib/upload.test.ts`                                | contract upload sessions > signs, uploads, sorts, and completes multipart sessions                                                                                      |
| 16 ms  | 5 ms   | `frontend/app/src/components/composer/profile-copies.test.ts`        | profile copy media readiness > fails a stalled read at the deadline and retries the retained Post once media is ready                                                   |
| 14 ms  | 5 ms   | `frontend/app/src/lib/api.test.ts`                                   | generated API client adapters > keeps bearer credentials on API calls and excludes them from signed object reads                                                        |
| 14 ms  | 5 ms   | `frontend/app/src/lib/auth-client.test.ts`                           | Better Auth JWT lifecycle > never persists the bearer credential to Web Storage                                                                                         |
| 14 ms  | 5 ms   | `frontend/app/src/lib/effect/runtime.test.ts`                        | runQueryEffect (React Query Effect adapter) > interrupts fiber when AbortSignal triggers cancellation                                                                   |
| 13 ms  | 5 ms   | `frontend/app/src/lib/queries.test.ts`                               | React Query helpers > refreshes the audit trail after every audited write                                                                                               |
| 13 ms  | 5 ms   | `frontend/app/src/lib/mutation-idempotency.test.ts`                  | mutation idempotency > reuses one key for equivalent retries until success clears it                                                                                    |
| 12 ms  | 5 ms   | `frontend/app/src/components/posts/post-analytics-history.test.ts`   | Post snapshot timelines > groups simultaneous syncs and preserves downward provider corrections                                                                         |
| 11 ms  | 5 ms   | `frontend/app/src/worker.test.ts`                                    | frontend Worker telemetry boundary > logs one structured, server-correlated event and returns 204                                                                       |
| 10 ms  | 5 ms   | `frontend/app/src/lib/frontend-telemetry.test.ts`                    | frontend telemetry boundary > emits only bounded, support-safe API error metadata                                                                                       |
| 9.7 ms | 5 ms   | `frontend/app/vite.config.test.ts`                                   | Vite frontend configuration > redirects alternate HTML navigations without redirecting canonical or asset requests                                                      |
| 7.0 ms | 5 ms   | `frontend/app/src/lib/auth-client.test.ts`                           | Better Auth JWT lifecycle > clears the bearer credential when sign-out fails server-side                                                                                |
| 6.9 ms | 5 ms   | `frontend/app/eslint-boundaries.test.ts`                             | astro UI contract > reports no violations across the real .astro tree                                                                                                   |
| 6.7 ms | 5 ms   | `frontend/app/src/lib/auth-client.test.ts`                           | Better Auth JWT lifecycle > forwards the refreshed JWT after a later session refresh                                                                                    |
| 6.7 ms | 5 ms   | `frontend/app/src/app/providers.test.ts`                             | reportQueryError > leaves an API failure to its own api-error record                                                                                                    |
| 6.6 ms | 5 ms   | `frontend/app/src/lib/copy-text.test.ts`                             | copyText > throws an error when clipboard access cannot be granted                                                                                                      |
| 6.6 ms | 5 ms   | `frontend/app/src/lib/auth-client.test.ts`                           | Better Auth JWT lifecycle > clears the bearer credential when the sign-out request rejects                                                                              |
| 6.6 ms | 5 ms   | `frontend/app/src/lib/queries.test.ts`                               | React Query helpers > refreshes Post, outcome, calendar, and attachment caches on every Post write                                                                      |
| 6.6 ms | 5 ms   | `frontend/app/src/lib/cookie-consent.test.ts`                        | optional cookie and storage consent > allows only the accepted optional purpose and remembers an explicit rejection                                                     |
| 6.3 ms | 5 ms   | `frontend/app/src/lib/copy-text.test.ts`                             | copyText > falls back after a rejected Clipboard API write                                                                                                              |
| 6.0 ms | 5 ms   | `frontend/app/src/lib/copy-text.test.ts`                             | copyText > focuses, selects, and cleans up the temporary textarea during legacy copy                                                                                    |
| 6.0 ms | 5 ms   | `frontend/app/src/lib/frontend-telemetry.test.ts`                    | frontend telemetry boundary > dispatches one redacted event without console or raw diagnostics                                                                          |
| 5.3 ms | 5 ms   | `frontend/app/src/lib/copy-text.test.ts`                             | copyText > uses the asynchronous Clipboard API in secure contexts                                                                                                       |
| 851 ms | 50 ms  | `packages/auth/test/index.test.ts`                                   | Better Auth device protocol HTTP composition > completes a CLI grant and keeps browser and CLI session lifecycles separate                                              |
| 975 ms | 50 ms  | `packages/database/test/migration-012.integration.test.ts`           | multi-user role migration > preserves the existing personal Workspace and its data as the shared Workspace                                                              |
| 107 ms | 50 ms  | `packages/database/test/rls.integration.test.ts`                     | Brand Profile ownership and lifecycle constraints > arms and preserves orphan clocks across processing and failed detaches                                              |
| 106 ms | 50 ms  | `packages/database/test/rls.integration.test.ts`                     | Brand Profile ownership and lifecycle constraints > requires brand_profile_id on owned tables and rejects cross-brand references                                        |
| 74 ms  | 50 ms  | `packages/database/test/rls.integration.test.ts`                     | PostgreSQL authenticated-role tenant isolation > requires admin deletion for a Post with published distributions                                                        |
| 73 ms  | 50 ms  | `packages/database/test/rls.integration.test.ts`                     | Brand Profile ownership and lifecycle constraints > enforces normalized unique names per workspace and reserves soft-deleted names                                      |
| 68 ms  | 50 ms  | `packages/database/test/rls.integration.test.ts`                     | Brand Profile ownership and lifecycle constraints > lets members write their own staging objects but not protected inventory                                            |
| 54 ms  | 50 ms  | `packages/database/test/rls.integration.test.ts`                     | Brand Profile ownership and lifecycle constraints > purges owned rows when a brand profile is deleted                                                                   |
| 11 ms  | 5 ms   | `packages/observability/test/effect-tracer.test.ts`                  | Effect Observability Tracer Integration > exports completed span with correlation context and timing                                                                    |
| 11 ms  | 5 ms   | `packages/observability/test/effect-logger.test.ts`                  | Effect Observability Logger Integration > routes Effect.log calls to Meltiply structured log with context and redaction                                                 |
| 10 ms  | 5 ms   | `packages/observability/test/flow-ledger.test.ts`                    | flow ledger > records runs, steps, and swallows database errors without throwing                                                                                        |
| 6.9 ms | 5 ms   | `packages/observability/test/index.test.ts`                          | observability safety > fingerprints exceptions in a bounded envelope without retaining credentials                                                                      |
| 362 ms | 5 ms   | `packages/providers/test/facebook.test.ts`                           | createFacebookAdapter > bounds pagination without discovered Pages                                                                                                      |
| 33 ms  | 5 ms   | `packages/providers/test/youtube.test.ts`                            | createYouTubeAdapter > creates, binds, and ends an encoder-backed live broadcast without uploading an Asset                                                             |
| 29 ms  | 5 ms   | `packages/providers/test/facebook.test.ts`                           | createFacebookAdapter > publishes a caption-only Page feed post without requiring a Reel                                                                                |
| 28 ms  | 5 ms   | `packages/providers/test/youtube.test.ts`                            | createYouTubeAdapter > assembles fragmented streams into bounded payloads without quadratic copying                                                                     |
| 28 ms  | 5 ms   | `packages/providers/test/effect.test.ts`                             | Effect provider safety > retries transient reads with virtual time and returns recovered data                                                                           |
| 27 ms  | 5 ms   | `packages/providers/test/threads.test.ts`                            | createThreadsAdapter > creates provider-hosted content without inventing a teaser caption: {"gif_attachment":{"gif_id":"native-gif","provider":"GIPHY"}}                |
| 27 ms  | 5 ms   | `packages/providers/test/facebook.test.ts`                           | createFacebookAdapter > fails closed when discovered pages exceed 1,000 bounds                                                                                          |
| 26 ms  | 5 ms   | `packages/providers/test/tiktok.test.ts`                             | createTikTokAdapter > delivers a video inbox draft without claiming publication                                                                                         |
| 24 ms  | 5 ms   | `packages/providers/test/instagram.test.ts`                          | createInstagramAdapter > reads a zero follower count from Instagram Login's single-account data envelope                                                                |
| 16 ms  | 5 ms   | `packages/providers/test/http.test.ts`                               | ProviderHttpClient > supports a fetch implementation requiring the global receiver                                                                                      |
| 11 ms  | 5 ms   | `packages/providers/test/http.test.ts`                               | ProviderHttpClient > times out stalled reads and treats possible writes as ambiguous                                                                                    |
| 6.3 ms | 5 ms   | `packages/providers/test/instagram.test.ts`                          | createInstagramAdapter > accepts three collaborators and rejects a fourth before calling Instagram                                                                      |
| 6.3 ms | 5 ms   | `packages/providers/test/instagram.test.ts`                          | createInstagramAdapter > keeps every attachment in a twenty-item Instagram carousel                                                                                     |
| 5.7 ms | 5 ms   | `packages/providers/test/http.test.ts`                               | ProviderHttpClient > keeps the timeout active while streaming the response body                                                                                         |
| 5.3 ms | 5 ms   | `packages/providers/test/index.test.ts`                              | ProviderRegistry > attaches adapter metadata to operation results and clears stale context                                                                              |
| 5.1 ms | 5 ms   | `packages/providers/test/facebook.test.ts`                           | createFacebookAdapter > discovers independent business Page edges concurrently without unbounded fan-out                                                                |
| 19 ms  | 5 ms   | `packages/storage/test/index.test.ts`                                | R2SigV4Signer key derivation > reuses a date-scoped signing key across concurrent requests                                                                              |
| 15 ms  | 5 ms   | `packages/storage/test/s3.test.ts`                                   | S3ObjectStore metadata > normalizes origin headers into ObjectMetadata                                                                                                  |
| 12 ms  | 5 ms   | `packages/storage/test/index.test.ts`                                | R2SigV4Signer > exercises StorageService live with full signer options and test defaults                                                                                |
| 9.8 ms | 5 ms   | `packages/storage/test/index.test.ts`                                | R2SigV4Signer > signs a path-prefixed S3 origin with large boundary slashes and binds required write headers                                                            |
| 9.4 ms | 5 ms   | `packages/storage/test/provider-media.test.ts`                       | provider-media signing and verification > signs and verifies a valid provider-media URL                                                                                 |
| 6.5 ms | 5 ms   | `packages/storage/test/provider.test.ts`                             | createObjectStoreFromEnv > signs with the resolved S3 region undefined                                                                                                  |
| 5.6 ms | 5 ms   | `packages/storage/test/s3.test.ts`                                   | S3ObjectStore multipart uploads > drives create, part, complete, and abort against the S3 protocol                                                                      |
| 11.4 s | 100 ms | `workers/api/test/query-budget.integration.test.ts`                  | core API PostgreSQL query budgets > holds statement and row counts constant for scaled core routes                                                                      |
| 1.5 s  | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | optional authenticator lifecycle > confirms enrollment, challenges sign-in, consumes backup codes once, regenerates and disables with password reauthentication         |
| 1.4 s  | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > keeps upload quota writes below the accepted local p95 latency budget                                                         |
| 1.4 s  | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > never mints a single-PUT grant past the recorded deadline when signing stalls across a cancel                          |
| 1.0 s  | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > freezes existing reservations across plan edits, and releases only the removed slot                              |
| 993 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | first-run bootstrap through the auth surface > applies the chosen Workspace name to the single canonical Workspace and resumes onboarding                               |
| 970 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > preserves the authoritative Post when an upload, save, or schedule is rejected                                         |
| 970 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | betterAuthFor local/test policy > keeps the historical default: unverified sign-in works, while sign-up still dispatches a verification email                           |
| 952 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > accepts community uploads and processing beyond finite-policy allowances                                               |
| 901 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > protects media for a retry window and for an ambiguous outcome awaiting reconciliation                                     |
| 834 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > reclaims a completed upload that was never attached once its seven days elapse                                             |
| 786 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > windows Queue assignments by UTC instant with inclusive start, exclusive end and stable pagination               |
| 780 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | distributed device abuse controls > counts per-device throttled polls against the caller ceiling before a new code can allocate a bucket                                |
| 718 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > keeps a saved draft's ready media charged under the same plan limit                                                    |
| 711 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | device code issuance contract > issues an unpredictable code bound to melti-cli with absolute same-origin verification links                                            |
| 697 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > refuses to reclaim media an unfinished rendition or a live Provider attempt still needs                                    |
| 677 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > lets an Editor release, reuse, and independently publish the same composition                                    |
| 654 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > serializes concurrent allocations and concurrent duplicate requests without reserving twice                      |
| 645 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > records an actionable native-processing failure, keeps a draft's copy, and reclaims an unretained one after its grace      |
| 598 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > lets an Admin manage Editors and configuration but not Admins or installation lifecycle                                                        |
| 594 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | bootstrap and invite-only sign-up > revokes old bearer and cookie authority on password change and password reset                                                       |
| 582 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | existing credential policy > requires the configured second factor before a CLI session can be approved                                                                 |
| 554 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > keeps Viewer read-only and Editor write access for CLI sessions                                                               |
| 549 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps an Asset another retained Post still references when one Post is deleted                                             |
| 536 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > cancels an upload, reclaims its staged bytes, and frees only its reservation                                           |
| 533 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > allocates successive future slots, preserves composition, and replays without another intent                     |
| 515 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > charges a reserved upload once and refuses the next payload with a stable quota error                                  |
| 501 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps a draft's failed attachment with its reason, then reclaims an unretained failed upload after its grace               |
| 499 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | password recovery through the shared sender > emails a usable reset link, signs in with the new password, and rejects expired/invalid tokens                            |
| 497 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > rejects preview and scheduling without a decoder-approved rendition while retaining original download                      |
| 489 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps a saved draft's attachment and its bytes however old the upload is                                                   |
| 487 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | existing credential policy > enforces required mailbox verification before releasing a CLI session                                                                      |
| 486 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | existing credential policy > revokes an issued CLI session when the existing security policy revokes sessions                                                           |
| 466 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > reclaims a confirmed-abort multipart upload immediately while a failed abort retains the charge                        |
| 443 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > previews an approved QuickTime upload through its ready MP4 rendition while downloads keep the original                    |
| 442 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > starts a fresh seven-day grace when the last retained attachment is removed                                                |
| 429 ms | 100 ms | `workers/api/test/query-budget.integration.test.ts`                  | core API PostgreSQL query budgets > keeps maximum-range analytics bounded and inside the statement timeout                                                              |
| 423 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > retains CLI provenance when a password change replaces and revokes the original credential                                    |
| 421 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > reserves output capacity atomically for concurrent processors                                                          |
| 416 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps a Post scheduled weeks ahead together with its scheduled Channel target                                              |
| 397 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | betterAuthFor staging policy > requires verification before sign-in, honors the emailed link, and blocks invalid/expired tokens                                         |
| 394 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > logs stored credential provenance despite spoofed hints and clears attribution after revocation                               |
| 393 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > bounds retained analytics summaries to sixty-four entries and recomputes after eviction                                       |
| 385 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | betterAuthFor production policy > requires verification before sign-in, honors the emailed link, and blocks invalid/expired tokens                                      |
| 383 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > suspends, blocks, reactivates, and hard-deletes an invited account                                                                             |
| 379 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | session cookie, bearer JWT, and sign-out > mints the session cookie and JWT, and sign-out revokes the stored session                                                    |
| 376 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | password recovery through the shared sender > does not reveal whether an email is registered                                                                            |
| 372 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps approved and published media unchanged when a still-valid upload grant is replayed after promotion                   |
| 370 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > skips a slot that elapses while waiting for a target lock                                                        |
| 361 ms | 100 ms | `workers/api/test/installation-transfer.integration.test.ts`         | installation ownership transfer > requires reauthentication, transfers between active admins, and audits both directions                                                |
| 360 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps a saved draft's in-flight attachment actionable when its session expires                                             |
| 355 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > claims, approves, and redeems exactly once while binding approval to the verifying session                                 |
| 349 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > administers the shared workspace, roles, invitations, seats, and audit                                                        |
| 348 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > expires an abandoned session, releases its reservation, and reclaims once                                              |
| 343 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | bootstrap and invite-only sign-up > blocks sign-in for a suspended account                                                                                              |
| 343 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > enforces configuration roles, membership roles, exact scheduling mode and Brand Profile scope                    |
| 339 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > cancels a retained upload without claiming its draft's media for deletion                                                  |
| 336 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > mints CLI JWTs, renews the session, and keeps the browser session after CLI sign-out                                          |
| 328 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > fails a retained draft's abandoned multipart upload without claiming its media                                             |
| 327 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | first-run bootstrap through the auth surface > admits an invited member without onboarding progress                                                                     |
| 324 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > handles concurrent usage reads over stale reservations without double-releasing or deadlocking                                |
| 317 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > reclaims a crashed settled write once while leaving a live upload and an emptied session alone                             |
| 315 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > allows owner read access to every content surface                                                                                              |
| 308 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > refuses a new attachment to media already claimed for reclamation                                                          |
| 307 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > enforces the ten-Seat limit and renews expired invitations atomically                                                         |
| 305 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > keeps a retained attachment and reclaimed bytes mutually exclusive when a save races the sweep                             |
| 305 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > denies a pending request after its claiming browser session ends instead of re-claiming it                                 |
| 304 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | bootstrap and invite-only sign-up > requires the setup secret, validates profile data, and closes public sign-up after bootstrap                                        |
| 296 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > releases each object's bytes once when a bucket delete fails midway and finishes on redelivery                             |
| 294 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > admits exactly one of two concurrent reservations at the plan limit                                                    |
| 293 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > concludes the processing lease once the committed rendition exists                                                         |
| 292 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > refuses approval from a different member and never claims their verification view                                          |
| 290 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | existing credential policy > denies an approved grant when enabling two-factor authentication revokes its browser session                                               |
| 282 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > schedules many Channels once with atomic usage and outbox state                                                               |
| 281 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | betterAuthFor self-hosted policy > allows unverified sign-in without mail only through the self-hosted opt-out                                                          |
| 270 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | onboarding save and completion > completes idempotently without changing a later Settings rename                                                                        |
| 264 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | bootstrap and invite-only sign-up > serializes concurrent first registrations so only one account is created                                                            |
| 259 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > keeps a redeemed CLI session after the approving browser signs out                                                            |
| 259 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > lets an Editor write content but not configure or administer                                                                                   |
| 259 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > reclaims a replayed upload once its writer window has lapsed, releasing the bytes once                                     |
| 255 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > validates Audit pagination and repairs an Audit entry on idempotent replay                                                                     |
| 254 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > does not issue a CLI session after the approving member is suspended                                                          |
| 251 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > previews invitations and rejects used, expired, revoked, and mismatched tokens                                                                 |
| 251 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | disclosure-version enforcement over real HTTP > fails closed on a null, stale, or unknown category disclosure version                                                   |
| 249 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > revives a dropped Channel instead of succeeding without publishing                                                            |
| 241 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | durable setup progress > remembers the reached optional screen across a restart after a skip                                                                            |
| 241 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > lets the Owner administer installation lifecycle while protecting their own account                                                            |
| 236 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > resolves calendar boundary 2026-10-26T08:30:00Z in Asia/Kathmandu deterministically                              |
| 236 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > holds a cancelled upload's staged bytes until its grant window lapses, then reclaims them once                             |
| 235 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > resolves calendar boundary 2026-03-08T06:00:00Z in America/New_York deterministically                            |
| 231 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | distributed device abuse controls > returns retryable HTTP outcomes for code-issuance and token-polling abuse                                                           |
| 231 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | native session transport and revocation > reports an expired CLI session as unusable                                                                                    |
| 228 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > mints a session only once a poll that observed the grant pending is followed by approval                                   |
| 227 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | onboarding completion and save ordering > serializes a concurrent save against completion                                                                               |
| 227 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > resolves calendar boundary 2026-11-01T04:00:00Z in America/New_York deterministically                            |
| 225 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > resolves calendar boundary 2026-10-25T23:59:59Z in UTC deterministically                                         |
| 224 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | durable setup progress > never moves the recorded screen backwards                                                                                                      |
| 223 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | durable setup progress > refuses an unknown field, an invalid step, and an empty body                                                                                   |
| 221 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > filters the Audit trail by action, target, and search text                                                                                     |
| 215 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | onboarding save and completion > moves onboarding authority with ownership transfer                                                                                     |
| 214 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | first-run bootstrap through the auth surface > keeps public registration closed while optional onboarding is unfinished                                                 |
| 213 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | first-run bootstrap through the auth surface > creates one account and one shared Workspace for concurrent first submissions                                            |
| 212 ms | 100 ms | `workers/api/test/analytics-history.integration.test.ts`             | keeps exact as-of ranking, unsynced coverage, counter deltas and bounded historical maxima through authenticated HTTP                                                   |
| 212 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | password recovery through the shared sender > rejects a reset token whose stored expiry has passed                                                                      |
| 210 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > denies access, reports access_denied once, and rejects malformed or unknown codes                                          |
| 209 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > allows only one of two concurrent redemptions                                                                              |
| 204 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | recoverable setup-name handoff > applies a name recorded only as pre-account intent                                                                                     |
| 204 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > serializes concurrent upload-count and storage-byte reservations                                                              |
| 201 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | first-run bootstrap through the auth surface > keeps the derived default when the form omits the Workspace name                                                         |
| 199 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > edits pending targets in place while leaving published history immutable                                                      |
| 196 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | bootstrap and invite-only sign-up > captures the chosen Workspace name as bootstrap data without storing it on the account                                              |
| 191 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > denies every alpha-owned mutation target from the beta tenant                                                                 |
| 189 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > re-keys deferred commands on reschedule and stops emitting beyond the delivery horizon                                        |
| 189 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > reserves quota, verifies uploaded metadata, and completes once                                                                |
| 188 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > allows admin read access to every content surface                                                                                              |
| 188 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > accepts an invitation through the link and hard-deletes the invited account                                                   |
| 186 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > allows viewer read access to every content surface                                                                                             |
| 185 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > composes text-only, media-only, and ordered multi-attachment Posts                                                            |
| 184 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > denies every Viewer mutation with the exact forbidden code of its guard                                                                        |
| 183 ms | 100 ms | `workers/api/test/permission-matrix.integration.test.ts`             | role permission matrix > allows editor read access to every content surface                                                                                             |
| 181 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > signs bounded multipart parts and rejects forged completion lists                                                             |
| 181 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | bounded local delivery > starts a new reporting interval when a category is re-enabled                                                                                  |
| 178 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > arms the reclamation clock only for media that loses its last reference                                                       |
| 175 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > keeps per-Channel outcomes editable only while they are pending                                                               |
| 171 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > reschedules pending Channels when a settled Channel's credential lapsed                                                       |
| 166 ms | 100 ms | `workers/api/test/device-auth.integration.test.ts`                   | browser verification and consent ownership > expires pending authorization without minting a session                                                                    |
| 164 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > emits per-target deferred commands inside the horizon and none beyond it                                                      |
| 164 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > admits only one schedule at the final concurrent quota slot                                                                   |
| 162 ms | 100 ms | `workers/api/test/publishing-queues.integration.test.ts`             | durable publishing Queues through authenticated HTTP > creates a reusable scoped weekly plan and reads it after another request                                         |
| 161 ms | 100 ms | `workers/api/test/publishing-preferences.integration.test.ts`        | publishing preferences HTTP > rejects an unsupported timezone, unknown placeholder, and missing default                                                                 |
| 161 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | consent-interval fencing over real HTTP > never sends a row claimed before a withdrawal after re-enabling                                                               |
| 155 ms | 100 ms | `workers/api/test/flow-observability.integration.test.ts`            | flow observability integration > scopes runs and steps to the caller's organization                                                                                     |
| 154 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > aborts and expires sessions while releasing reservations                                                                      |
| 154 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > deletes a Post by cancelling only its pending work                                                                            |
| 151 ms | 100 ms | `workers/api/test/query-budget.integration.test.ts`                  | core API PostgreSQL query budgets > walks scaled list pages within a constant per-page statement count and correct page flags                                           |
| 149 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > keeps claimed publication work alive when its Post is deleted                                                                 |
| 149 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > reschedules Channels whose ordered selections and hashtags differ                                                             |
| 149 ms | 100 ms | `workers/api/test/upload-quota.integration.test.ts`                  | workspace storage Entitlements with PostgreSQL > keeps resident object bytes counted across a monthly period rollover                                                   |
| 148 ms | 100 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`          | post-owned media retention with PostgreSQL > aborts a confirmed abandoned multipart upload and releases its charge exactly once                                         |
| 145 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > reads the frozen publication identically on Post and Distribution after edits                                                 |
| 142 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > emits one distinct outbox command for every accepted distribution retry intent                                                |
| 141 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > resolves ambiguous distributions through an idempotent operator audit                                                         |
| 140 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > removes deleted Posts from Calendar while retaining published history                                                         |
| 139 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | reporting policy over real HTTP > defaults both categories to off with no installation identity                                                                         |
| 138 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > completes logical single abort over HTTP after remote cleanup fails                                                           |
| 138 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | diagnostic ingestion > keeps a repeated failure within one hour as a single report                                                                                      |
| 135 ms | 50 ms  | `workers/api/test/operator-reconciliation-usage.integration.test.ts` | operator-confirmed publication measurement > counts an operator-confirmed success exactly once                                                                          |
| 134 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > completes logical multipart abort over HTTP after remote cleanup fails                                                        |
| 133 ms | 100 ms | `workers/api/test/flow-observability.integration.test.ts`            | flow observability integration > records a sanitized run and steps for an authenticated request                                                                         |
| 133 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | discovery-source feedback > uses a separate random identity from the installation reporting id                                                                          |
| 132 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > releases abandoned upload reservations lazily on the next usage read for retry within quota                                   |
| 131 ms | 100 ms | `workers/api/test/publishing-preferences.integration.test.ts`        | publishing preferences HTTP > persists multiple normalized email recipients and requires one when enabled                                                               |
| 131 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | consent-interval fencing over real HTTP > admits a same-hour failure from the re-enabled interval                                                                       |
| 130 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > requires and persists explicit TikTok publishing choices                                                                      |
| 130 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | discovery-source feedback > reports delivered only after the destination accepts the report                                                                             |
| 130 ms | 100 ms | `workers/api/test/publication-requirements.integration.test.ts`      | publishing-requirement coalescing with PostgreSQL RLS > performs a fresh authenticated Provider read after each settlement                                              |
| 129 ms | 100 ms | `workers/api/test/publishing-preferences.integration.test.ts`        | publishing preferences HTTP > persists timezone, ordered signatures, and notification choices                                                                           |
| 129 ms | 100 ms | `workers/api/test/publication-requirements-runtime.test.ts`          | publishing-requirement coalescing in the workerd runtime > shares one pending Provider read across concurrent requests with independent response IDs                    |
| 126 ms | 100 ms | `workers/api/test/publishing-preferences.integration.test.ts`        | publishing preferences HTTP > replays the same replacement without writing a second result                                                                              |
| 123 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > saves and clears a Channel-less draft while scheduling requires one                                                           |
| 122 ms | 100 ms | `workers/api/test/better-auth.integration.test.ts`                   | shared credential and delivery budgets > shares normalized credential and delivery budgets across independent callers                                                   |
| 118 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > allows a resend retry after a definitive mail failure                                                                         |
| 115 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > allows missing-object completion to retry after upload visibility                                                             |
| 114 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > accepts an idempotent schedule and removes its unpublished work on cancel                                                     |
| 114 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > cancel keeps leased publish work for the automation consumer                                                                  |
| 110 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > blocks a suspended member before a warm analytics cache can be reused                                                         |
| 107 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | discovery-source feedback > reuses the recorded logical identity and the frozen event identity on a retry                                                               |
| 103 ms | 100 ms | `workers/api/test/reporting.integration.test.ts`                     | consent-interval fencing over real HTTP > discards a claimed row whose category was withdrawn                                                                           |
| 102 ms | 100 ms | `workers/api/test/onboarding.integration.test.ts`                    | onboarding save and completion > reports an upgraded installation as not applicable instead of resuming setup                                                           |
| 100 ms | 100 ms | `workers/api/test/core-service.integration.test.ts`                  | Worker core service with PostgreSQL RLS > never releases active unexpired upload reservations on usage reads                                                            |
| 59 ms  | 50 ms  | `workers/api/test/operator-reconciliation-usage.integration.test.ts` | operator-confirmed publication measurement > keeps the domain resolution committed when reporting is unavailable                                                        |
| 52 ms  | 50 ms  | `workers/api/test/operator-reconciliation-usage.integration.test.ts` | operator-confirmed publication measurement > counts nothing while usage is not enabled, and never backfills later                                                       |
| 20 ms  | 5 ms   | `workers/api/test/runtime.test.ts`                                   | runWorkerEffect (Cloudflare/Hono Effect boundary runner) > ensures request context does not leak between concurrent requests                                            |
| 12 ms  | 5 ms   | `workers/api/test/diagnostic-reporting.test.ts`                      | failed invocation reporting > preserves the mapped status and envelope when reporting is unavailable                                                                    |
| 10 ms  | 5 ms   | `workers/api/test/runtime.test.ts`                                   | runWorkerEffect (Cloudflare/Hono Effect boundary runner) > executes successful effect and returns canonical jsonResponse                                                |
| 10 ms  | 5 ms   | `workers/api/test/publication-requirements.test.ts`                  | getPublicationRequirementsEffect > returns publication requirements on success                                                                                          |
| 9.0 ms | 5 ms   | `workers/api/test/flow-observability.test.ts`                        | pending span pruning > caps pending spans by evicting the oldest entries first                                                                                          |
| 8.0 ms | 5 ms   | `workers/api/test/verifier-cache.test.ts`                            | verifier cache > verifies internal JWKS tokens without weakening public issuer or audience                                                                              |
| 7.0 ms | 5 ms   | `workers/api/test/runtime.test.ts`                                   | runWorkerEffect (Cloudflare/Hono Effect boundary runner) > maps unexpected defects to 500 internal_error                                                                |
| 7.0 ms | 5 ms   | `workers/api/test/publishing-domain.test.ts`                         | Post composition > rejects an empty new Post as a typed validation failure                                                                                              |
| 7.0 ms | 5 ms   | `workers/api/test/publishing-domain.test.ts`                         | Post composition > issues a new publish command when republishing a cancelled Distribution                                                                              |
| 7.0 ms | 5 ms   | `workers/api/test/publication-requirements.test.ts`                  | getPublicationRequirementsEffect > retains at most 32 pending keys and bypasses coalescing beyond capacity                                                              |
| 7.0 ms | 5 ms   | `workers/api/test/object-storage-provider.test.ts`                   | API storage layer > signs browser uploads against the configured S3 origin                                                                                              |
| 517 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > bounds each cleanup class across two maintenance sweeps                                                                               |
| 368 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > publishes from the authenticated API through PostgreSQL and the outbox Queue                                                          |
| 201 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > settles a demoted 'original' rendition with the verdict so the orphan sweep can claim the asset                                       |
| 172 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > reclaims a superseded original after promotion once holds expire, preserving promoted and rendition bytes with exact quota settlement |
| 162 ms | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > counts one Post and two Distributions when one Post publishes to two Channels                                           |
| 149 ms | 5 ms   | `workers/automation/test/worker.test.ts`                             | Distribution message processing > reconciles a stalled in-progress distribution after worker loss instead of publishing again                                           |
| 149 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > promotes a staged upload through the native engine into a ready rendition                                                             |
| 145 ms | 50 ms  | `workers/automation/test/retention.integration.test.ts`              | retention cleanup with PostgreSQL > defers a due profile until active work ends, then purges objects                                                                    |
| 144 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > clears a partially recorded staging row back to a clean reservation                                                                   |
| 143 ms | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > includes an in-flight measurement instead of dropping it                                                                |
| 141 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > recomputes an engine verdict whose staged bytes the Worker deleted instead of replaying it                                            |
| 140 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > replays the recorded verdict when a stale grant re-created byte-identical output                                                      |
| 134 ms | 50 ms  | `workers/automation/test/comment-policy.integration.test.ts`         | Comment collection deployment policy > recovers authorized demand after a lost send, completes every page, then stops                                                   |
| 129 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > fails permanently when re-created staging bytes carry a different stored digest                                                       |
| 125 ms | 50 ms  | `workers/automation/test/improvement-reporting.integration.test.ts`  | scheduled improvement reporting with PostgreSQL > delivers a consented report and marks it sent                                                                         |
| 123 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > re-arms the full reservation before clearing untrusted staged output                                                                  |
| 122 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > keeps the reservation charged across a retryable engine failure                                                                       |
| 108 ms | 50 ms  | `workers/automation/test/retention.integration.test.ts`              | retention cleanup with PostgreSQL > purges only due brand profiles and deletes their stored objects first                                                               |
| 108 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > counts a live upload reservation before granting any new capacity                                                                     |
| 106 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > processes a single upload outbox event exactly once and prevents batch collisions from double-consuming quota                         |
| 105 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > leases due provider sync work and persists checkpoints atomically                                                                     |
| 101 ms | 100 ms | `workers/automation/test/assets.integration.test.ts`                 | Automation jobs with PostgreSQL > polls provider publication status to a confirmed durable result                                                                       |
| 99 ms  | 50 ms  | `workers/automation/test/comment-policy.integration.test.ts`         | Comment collection deployment policy > does not sweep or consume recurring work by default and retains existing history                                                 |
| 99 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > counts an ambiguous outcome only once reconciliation confirms it                                                        |
| 98 ms  | 50 ms  | `workers/automation/test/distribution.integration.test.ts`           | Distribution publication with PostgreSQL > keeps Instagram partial success published and blocks a later publish trigger                                                 |
| 95 ms  | 50 ms  | `workers/automation/test/reply-reconciliation.integration.test.ts`   | reply reconciliation enqueue with PostgreSQL > enqueues expired work once, skips live leases, and advances dedupe keys                                                  |
| 93 ms  | 50 ms  | `workers/automation/test/retention.integration.test.ts`              | retention cleanup with PostgreSQL > deletes bounded old rows while retaining fresh and processing rows                                                                  |
| 84 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > gauges connected Channels, excluding revoked and expired ones                                                                    |
| 82 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > does not count a publication that succeeded before consent                                                              |
| 80 ms  | 50 ms  | `workers/automation/test/distribution.integration.test.ts`           | Distribution publication with PostgreSQL > refuses a multi-attachment Post on a single-file Platform before delivery                                                    |
| 75 ms  | 5 ms   | `workers/automation/test/effect-boundary.test.ts`                    | automation queue duplicate delivery > retries a transport TypeError and acks the redelivery on success                                                                  |
| 72 ms  | 50 ms  | `workers/automation/test/distribution.integration.test.ts`           | Distribution publication with PostgreSQL > delivers the frozen rendition and keeps it held through the retrieval window                                                 |
| 71 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > never mutates an established Post mark when another Channel succeeds                                                    |
| 71 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > reports a Distribution with no snapshot as coverage-missing                                                                      |
| 71 ms  | 50 ms  | `workers/automation/test/distribution.integration.test.ts`           | Distribution publication with PostgreSQL > keeps one Post's channel outcomes independent after partial success                                                          |
| 70 ms  | 50 ms  | `workers/automation/test/reply-reconciliation.integration.test.ts`   | reply container lifecycle with PostgreSQL > keeps an operation-only reply pending, then finalizes it exactly once                                                       |
| 68 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > counts again in a new interval after a withdrawal and re-enable                                                         |
| 66 ms  | 5 ms   | `workers/automation/test/worker.test.ts`                             | Automation Worker foundation > logs safe diagnostics when scheduled work fails                                                                                          |
| 62 ms  | 50 ms  | `workers/automation/test/notifications.integration.test.ts`          | notification delivery > alerts once on a live disconnect transition and not on deletion                                                                                 |
| 62 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > reuses one report identity when a scheduled run repeats                                                                          |
| 60 ms  | 50 ms  | `workers/automation/test/notifications.integration.test.ts`          | notification delivery > retries transient failures and stops at the bounded attempt limit                                                                               |
| 58 ms  | 50 ms  | `workers/automation/test/account-analytics.integration.test.ts`      | account analytics sweep with PostgreSQL > rotates past a failed full batch and backs off failures without inventing captures                                            |
| 57 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > omits a metric one mixed-cohort contributor could not establish                                                                  |
| 56 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > counts a new Distribution when a sibling published before measurement existed                                           |
| 56 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > queues one frozen report for a closed UTC day                                                                                    |
| 55 ms  | 50 ms  | `workers/automation/test/improvement-reporting.integration.test.ts`  | scheduled improvement reporting with PostgreSQL > keeps capture traffic off the diagnostic producer until scheduled delivery                                            |
| 54 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | usage publication measurement with PostgreSQL > keeps the measured counters after the Post is deleted                                                                   |
| 52 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > omits an unmeasured metric and names it in the coverage                                                                          |
| 52 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > reports only the latest stored snapshot and never substitutes reach for views                                                    |
| 51 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > keeps a downward correction instead of accumulating it                                                                           |
| 51 ms  | 50 ms  | `workers/automation/test/usage-reporting.integration.test.ts`        | daily usage producer with PostgreSQL > reports a Platform with no analytics capability as unsupported, not zero                                                         |
| 32 ms  | 5 ms   | `workers/automation/test/channel-revocation.test.ts`                 | channel revocation queue dispatch > acks a processed revocation and retries a retryable provider failure                                                                |
| 23 ms  | 5 ms   | `workers/automation/test/worker.test.ts`                             | Automation Worker foundation > acks unsupported queue messages without retrying them                                                                                    |
| 12 ms  | 5 ms   | `workers/automation/test/provider-sync-due.test.ts`                  | provider analytics snapshot deduplication > updates when watch time, reach, or impressions change without raw_data churn                                                |
| 11 ms  | 5 ms   | `workers/automation/test/worker.test.ts`                             | Scheduled entry delayed delivery > sends scheduled publishes with bounded delays and suppresses beyond-horizon commands                                                 |
| 11 ms  | 5 ms   | `workers/automation/test/channel-revocation.test.ts`                 | channel revocation outbox routing > relays a revocation event to its queue with the strict payload allowlist                                                            |
| 11 ms  | 5 ms   | `workers/automation/test/outbox.test.ts`                             | outbox relay publication > publishes all messages for a binding with one sendBatch call                                                                                 |
| 10 ms  | 5 ms   | `workers/automation/test/worker.test.ts`                             | Automation Worker foundation > reports a failing unit without silently skipping the remaining tiers                                                                     |
| 9.0 ms | 5 ms   | `workers/automation/test/worker.test.ts`                             | Automation Worker foundation > acks durable asset work and retries transient failures individually                                                                      |
| 9.0 ms | 5 ms   | `workers/automation/test/worker.test.ts`                             | Automation Worker foundation > reports every failing unit and still runs the independent work                                                                           |
| 9.0 ms | 5 ms   | `workers/automation/test/worker.test.ts`                             | Due work scheduled claim protocol > drives descriptor-selected claims across scheduled cron tiers                                                                       |
| 9.0 ms | 5 ms   | `workers/automation/test/effect-boundary.test.ts`                    | automation queue duplicate delivery > acks a redelivered message without retrying it                                                                                    |
| 9.0 ms | 5 ms   | `workers/automation/test/reply-reconciliation.test.ts`               | reply reconciliation delayed triggers > emits a reconciliation entry carrying the first cadence delay when a reply delivery is ambiguous                                |
| 8.0 ms | 5 ms   | `workers/automation/test/worker.test.ts`                             | Automation Worker foundation > exposes an internal liveness response                                                                                                    |
| 8.0 ms | 5 ms   | `workers/automation/test/effect-boundary.test.ts`                    | automation Effect boundary mapping > maps success to processed                                                                                                          |
| 8.0 ms | 5 ms   | `workers/automation/test/provider-sync-provider.test.ts`             | provider synchronization execution > normalizes analytics and keeps credentials outside the page request                                                                |
| 7.0 ms | 5 ms   | `workers/automation/test/distribution-provider.test.ts`              | provider publication execution > fails closed before credentials when no adapter is accepted                                                                            |
| 7.0 ms | 5 ms   | `workers/automation/test/outbox.test.ts`                             | outbox relay publication > leaves accepted messages leased without marking them failed when markPublished fails                                                         |
| 7.0 ms | 5 ms   | `workers/automation/test/account-analytics.test.ts`                  | sweepAccountAnalytics > keeps per-account provider failures as counts while recording the rest                                                                          |
| 7.0 ms | 5 ms   | `workers/automation/test/retention.test.ts`                          | retention cleanup > purges owed bytes through the configured object storage provider                                                                                    |
| 6.0 ms | 5 ms   | `workers/automation/test/effect-boundary.test.ts`                    | automation queue duplicate delivery > retries failed queue publishing and acks a successful redelivery                                                                  |
| 6.0 ms | 5 ms   | `workers/automation/test/provider-sync-provider.test.ts`             | redelivered provider sync messages > performs no second token refresh when the same event key is redelivered                                                            |
| 6.0 ms | 5 ms   | `workers/automation/test/provider-media.test.ts`                     | provider media resolver > creates a 24-hour remote-ingest URL after authoritative R2 metadata                                                                           |
| 6.0 ms | 5 ms   | `workers/automation/test/retention.test.ts`                          | retention cleanup > rejects out-of-range batch sizes without opening a transaction                                                                                      |
| 6.0 ms | 5 ms   | `workers/automation/test/usage.test.ts`                              | usage reconciliation > rejects out-of-range batch limits and invalid dates                                                                                              |
| 6.0 ms | 5 ms   | `workers/automation/test/object-storage-provider.test.ts`            | processor job capabilities > mints the R2 capabilities the default provider implies                                                                                     |
| 177 ms | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > stores, lists, claims, completes, and cancels large candidate sets without oversized storage ops                                                |
| 97 ms  | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > paginates candidate deletion via startAfter across >1000 keys                                                                                   |
| 89 ms  | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > enforces the original ticket deadline while permitting bounded late completion                                                                  |
| 79 ms  | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > pins selected account and enforces cross-store crash invariants across retries                                                                  |
| 60 ms  | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > rejects cancellation when claim lease has expired but save is unreleased (stale lease fence)                                                    |
| 55 ms  | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > cancels an in-flight selection and wipes candidate credential entries                                                                           |
| 51 ms  | 50 ms  | `workers/state/test/oauth-state.test.ts`                             | OAuthStateCoordinator > rejects duplicate candidate account IDs and >1000-account appends before writing entries                                                        |

## Appendix: every file over the 100 ms setup budget after

| Setup  | File                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| 12.4 s | `workers/api/test/core-routes.test.ts`                                         |
| 10.7 s | `frontend/app/src/preview/handlers.test.ts`                                    |
| 8.6 s  | `workers/automation/test/worker.test.ts`                                       |
| 7.5 s  | `frontend/app/src/components/composer/composer.test.tsx`                       |
| 6.8 s  | `frontend/app/src/components/composer/schedule-date-time.test.tsx`             |
| 5.9 s  | `workers/state/test/oauth-state.test.ts`                                       |
| 5.6 s  | `workers/api/test/app.test.ts`                                                 |
| 5.5 s  | `workers/api/test/publication-requirements-runtime.test.ts`                    |
| 5.4 s  | `workers/api/test/broadcast-control.test.ts`                                   |
| 5.4 s  | `workers/api/test/inbox-comment-sync.test.ts`                                  |
| 5.4 s  | `workers/api/test/current-user-effect.test.ts`                                 |
| 5.4 s  | `workers/api/test/outbox-relay.test.ts`                                        |
| 5.3 s  | `workers/api/test/operator-routes.test.ts`                                     |
| 5.3 s  | `workers/api/test/current-user.test.ts`                                        |
| 5.3 s  | `workers/api/test/reporting-routes.test.ts`                                    |
| 5.3 s  | `workers/api/test/request-boundary.test.ts`                                    |
| 4.9 s  | `workers/api/test/publishing-domain.test.ts`                                   |
| 4.3 s  | `workers/automation/test/asset-processing.test.ts`                             |
| 4.1 s  | `workers/api/test/validation.test.ts`                                          |
| 3.8 s  | `workers/automation/test/channel-revocation.test.ts`                           |
| 3.8 s  | `workers/automation/test/reply-reconciliation.test.ts`                         |
| 3.8 s  | `workers/automation/test/outbox.test.ts`                                       |
| 3.7 s  | `workers/automation/test/provider-sync-due.test.ts`                            |
| 3.7 s  | `workers/api/test/diagnostic-reporting.test.ts`                                |
| 3.7 s  | `workers/automation/test/retention.test.ts`                                    |
| 3.6 s  | `workers/automation/test/provider-sync-provider.test.ts`                       |
| 3.6 s  | `workers/api/test/runtime.test.ts`                                             |
| 3.6 s  | `workers/automation/test/diagnostic-reporting.test.ts`                         |
| 3.6 s  | `workers/automation/test/effect-boundary.test.ts`                              |
| 3.6 s  | `workers/automation/test/effect-services.test.ts`                              |
| 3.6 s  | `workers/api/test/publication-requirements.test.ts`                            |
| 3.6 s  | `workers/automation/test/account-analytics.test.ts`                            |
| 3.6 s  | `workers/automation/test/distribution-provider.test.ts`                        |
| 3.6 s  | `workers/automation/test/usage.test.ts`                                        |
| 3.5 s  | `workers/automation/test/provider-media.test.ts`                               |
| 3.5 s  | `workers/automation/test/outbox-routing.test.ts`                               |
| 3.4 s  | `workers/api/test/actor-resolution.test.ts`                                    |
| 3.4 s  | `workers/api/test/token-credentials.test.ts`                                   |
| 3.4 s  | `workers/api/test/object-storage-provider.test.ts`                             |
| 3.3 s  | `workers/api/test/mail.test.ts`                                                |
| 3.3 s  | `workers/automation/test/object-storage-provider.test.ts`                      |
| 3.3 s  | `workers/automation/test/flow-observability.test.ts`                           |
| 3.3 s  | `workers/api/test/flow-observability.test.ts`                                  |
| 3.3 s  | `workers/automation/test/provider-credentials.test.ts`                         |
| 2.7 s  | `frontend/app/src/components/brand-profile-scope.test.tsx`                     |
| 2.2 s  | `frontend/app/eslint-boundaries.test.ts`                                       |
| 1.8 s  | `frontend/app/vite.config.test.ts`                                             |
| 1.7 s  | `frontend/app/src/components/layout/workspace-settings.test.tsx`               |
| 1.6 s  | `frontend/app/src/components/analytics/analytics-view.test.tsx`                |
| 1.3 s  | `frontend/app/src/components/analytics/analytics-insights.test.tsx`            |
| 1.3 s  | `frontend/app/src/components/analytics/analytics-components.test.tsx`          |
| 1.3 s  | `frontend/app/src/components/devbox/dev-box.test.tsx`                          |
| 1.3 s  | `workers/api/test/contract-conformance.node.test.ts`                           |
| 1.3 s  | `frontend/app/src/components/layout/workspace-navigation.test.tsx`             |
| 1.2 s  | `workers/automation/test/usage-reporting.integration.test.ts`                  |
| 1.2 s  | `workers/api/test/query-budget.integration.test.ts`                            |
| 1.1 s  | `frontend/app/src/components/settings-page.test.tsx`                           |
| 1.1 s  | `workers/api/test/onboarding.integration.test.ts`                              |
| 1.1 s  | `frontend/app/src/components/channels/channels-selection.test.tsx`             |
| 1.1 s  | `frontend/app/src/components/posts/post-calendar-grid-view.test.tsx`           |
| 1.0 s  | `frontend/app/src/components/composer/platform-settings.test.tsx`              |
| 1.0 s  | `workers/automation/test/assets.integration.test.ts`                           |
| 971 ms | `frontend/app/src/components/posts/post-table-view.test.tsx`                   |
| 838 ms | `workers/api/test/publishing-queues.integration.test.ts`                       |
| 825 ms | `workers/api/test/better-auth.integration.test.ts`                             |
| 798 ms | `workers/api/test/upload-quota.integration.test.ts`                            |
| 796 ms | `workers/api/test/core-service.integration.test.ts`                            |
| 786 ms | `frontend/app/src/components/workspace/brand-profile-dialog.test.tsx`          |
| 780 ms | `frontend/app/src/components/channels/channel-assignment.test.tsx`             |
| 774 ms | `frontend/app/src/components/auth/sign-in-form.test.tsx`                       |
| 772 ms | `frontend/app/src/components/layout/navigation-shell.test.tsx`                 |
| 767 ms | `packages/providers/test/facebook.test.ts`                                     |
| 756 ms | `packages/database/test/migration-012.integration.test.ts`                     |
| 752 ms | `frontend/app/src/app/device-consent-route.test.tsx`                           |
| 750 ms | `packages/contracts/test/examples.test.ts`                                     |
| 748 ms | `frontend/app/src/app/invitation-accept-route.test.tsx`                        |
| 721 ms | `frontend/app/src/components/posts/calendar-date-detail-dialog.test.tsx`       |
| 717 ms | `workers/api/test/device-auth.integration.test.ts`                             |
| 713 ms | `frontend/app/src/components/settings/publishing-preferences-section.test.tsx` |
| 708 ms | `workers/api/test/analytics-history.integration.test.ts`                       |
| 707 ms | `frontend/app/src/lib/platform-capabilities-retention.test.tsx`                |
| 706 ms | `frontend/app/src/components/posts/post-analytics-section.test.tsx`            |
| 690 ms | `frontend/app/src/components/settings/audit-log-table.test.tsx`                |
| 685 ms | `workers/api/test/publishing-preferences.integration.test.ts`                  |
| 677 ms | `workers/api/test/post-media-lifecycle.integration.test.ts`                    |
| 676 ms | `frontend/app/src/components/posts/posts-helpers.test.ts`                      |
| 662 ms | `frontend/app/src/lib/browser-cache.test.tsx`                                  |
| 661 ms | `workers/api/test/publication-requirements.integration.test.ts`                |
| 660 ms | `frontend/app/src/components/posts/post-row.test.ts`                           |
| 654 ms | `workers/api/test/permission-matrix.integration.test.ts`                       |
| 651 ms | `frontend/app/src/lib/posts-pagination.test.tsx`                               |
| 622 ms | `frontend/app/src/components/devbox/helpers-tab.test.tsx`                      |
| 620 ms | `workers/api/test/flow-observability.integration.test.ts`                      |
| 619 ms | `workers/api/test/reporting.integration.test.ts`                               |
| 616 ms | `frontend/app/src/app/providers.test.ts`                                       |
| 601 ms | `frontend/app/src/lib/platforms.test.ts`                                       |
| 601 ms | `frontend/app/src/components/ui/menu-width.test.tsx`                           |
| 596 ms | `frontend/app/src/components/segmented-control.test.tsx`                       |
| 596 ms | `workers/api/test/installation-transfer.integration.test.ts`                   |
| 593 ms | `packages/storage/test/index.test.ts`                                          |
| 581 ms | `workers/automation/test/distribution.integration.test.ts`                     |
| 569 ms | `frontend/app/src/components/ui/filter-select.test.tsx`                        |
| 557 ms | `packages/contracts/test/brand-profiles.test.ts`                               |
| 556 ms | `frontend/app/src/lib/cookie-notice.test.tsx`                                  |
| 548 ms | `workers/automation/test/account-analytics.integration.test.ts`                |
| 546 ms | `packages/contracts/test/schema-constraints.test.ts`                           |
| 544 ms | `frontend/app/src/lib/i18n.catalog.test.ts`                                    |
| 537 ms | `workers/automation/test/retention.integration.test.ts`                        |
| 533 ms | `workers/automation/test/queue-recovery.integration.test.ts`                   |
| 512 ms | `frontend/app/src/lib/sileo.test.tsx`                                          |
| 511 ms | `frontend/app/src/components/component-accessibility.test.tsx`                 |
| 494 ms | `packages/database/test/rls.integration.test.ts`                               |
| 487 ms | `packages/database/test/index.test.ts`                                         |
| 476 ms | `workers/automation/test/reply-reconciliation.integration.test.ts`             |
| 472 ms | `packages/reporting/test/sanitize.test.ts`                                     |
| 468 ms | `packages/observability/test/index.test.ts`                                    |
| 466 ms | `frontend/app/src/components/posts/calendar-dates.test.ts`                     |
| 465 ms | `packages/secrets/test/index.test.ts`                                          |
| 459 ms | `frontend/app/src/lib/publishing-preferences.test.ts`                          |
| 456 ms | `frontend/app/src/lib/queries.test.ts`                                         |
| 455 ms | `frontend/app/src/components/layout/top-toolbar.test.tsx`                      |
| 451 ms | `frontend/app/src/components/posts/calendar-slots.test.ts`                     |
| 451 ms | `frontend/app/src/components/posts/post-groups.test.ts`                        |
| 441 ms | `packages/providers/test/youtube.test.ts`                                      |
| 437 ms | `workers/api/test/operator-reconciliation-usage.integration.test.ts`           |
| 434 ms | `packages/providers/test/threads.test.ts`                                      |
| 431 ms | `frontend/app/src/components/posts/status-badge.test.tsx`                      |
| 430 ms | `packages/providers/test/tiktok.test.ts`                                       |
| 428 ms | `workers/automation/test/notifications.integration.test.ts`                    |
| 425 ms | `frontend/app/src/worker.test.ts`                                              |
| 425 ms | `packages/providers/test/instagram.test.ts`                                    |
| 425 ms | `packages/providers/test/index.test.ts`                                        |
| 421 ms | `packages/providers/test/http.test.ts`                                         |
| 421 ms | `packages/providers/test/effect.test.ts`                                       |
| 417 ms | `workers/automation/test/comment-policy.integration.test.ts`                   |
| 417 ms | `frontend/app/src/components/posts/post-actions.test.tsx`                      |
| 415 ms | `packages/providers/test/validator.test.ts`                                    |
| 409 ms | `packages/domain/test/effect.test.ts`                                          |
| 404 ms | `packages/storage/test/s3.test.ts`                                             |
| 403 ms | `frontend/app/src/lib/api.test.ts`                                             |
| 402 ms | `packages/reporting/test/policy.test.ts`                                       |
| 401 ms | `workers/automation/test/improvement-reporting.integration.test.ts`            |
| 397 ms | `frontend/app/src/components/composer/profile-copies.test.ts`                  |
| 396 ms | `packages/providers/test/values.test.ts`                                       |
| 390 ms | `packages/storage/test/provider.test.ts`                                       |
| 390 ms | `packages/storage/test/provider-media.test.ts`                                 |
| 384 ms | `packages/domain/test/index.test.ts`                                           |
| 384 ms | `frontend/app/src/app/channel-connect-route.test.tsx`                          |
| 384 ms | `packages/reporting/test/diagnostics.test.ts`                                  |
| 382 ms | `packages/providers/test/rate-limit.test.ts`                                   |
| 379 ms | `frontend/app/src/components/center-dialog.test.tsx`                           |
| 378 ms | `packages/observability/test/effect-logger.test.ts`                            |
| 378 ms | `packages/observability/test/effect-tracer.test.ts`                            |
| 377 ms | `packages/observability/test/flow-ledger.test.ts`                              |
| 370 ms | `frontend/app/src/components/auth/auth-provider.test.tsx`                      |
| 368 ms | `frontend/app/src/components/center-dialog-motion.test.tsx`                    |
| 359 ms | `frontend/app/src/components/auth/auth-boundary.test.tsx`                      |
| 357 ms | `packages/auth/test/index.test.ts`                                             |
| 352 ms | `frontend/app/src/lib/query-defaults.test.ts`                                  |
| 351 ms | `frontend/app/src/lib/effect/runtime.test.ts`                                  |
| 341 ms | `frontend/app/src/lib/upload.test.ts`                                          |
| 327 ms | `frontend/app/src/components/devbox/routes-tab.test.tsx`                       |
| 316 ms | `frontend/app/src/lib/frontend-telemetry.test.ts`                              |
| 305 ms | `frontend/app/src/lib/auth-client.test.ts`                                     |
| 268 ms | `workers/api/test/verifier-cache.test.ts`                                      |
| 231 ms | `frontend/app/src/lib/i18n.test.tsx`                                           |
| 227 ms | `frontend/app/src/components/reduced-motion-preference.test.tsx`               |
| 224 ms | `frontend/app/src/components/ui/button.test.tsx`                               |
| 211 ms | `frontend/app/src/lib/theme.test.tsx`                                          |
| 211 ms | `frontend/app/src/components/workspace/brand-profile-color-picker.test.tsx`    |
| 197 ms | `frontend/app/src/lib/navigation.test.ts`                                      |
| 133 ms | `frontend/app/src/lib/hotkeys.test.ts`                                         |
| 124 ms | `packages/contracts/test/live-worker.test.ts`                                  |
| 117 ms | `frontend/app/src/lib/frontend-errors.test.ts`                                 |
| 111 ms | `frontend/app/src/lib/theme-bootstrap.test.ts`                                 |
