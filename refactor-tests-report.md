# Test suite refactor report

## Status

The whole-suite TypeScript test refactor on branch `refactor/test-suite` (base commit `43fba6a`, `HEAD` `9040b2b`) covers all 13 workspaces in `packages/`, `workers/`, and `frontend/app`.

- **Test count more than doubled** (`2,735` → `6,004` executed tests: `2,283` → `5,333` unit/contract/component tests and `452` → `671` PostgreSQL integration tests), rewriting tests to one example per test with direct unit tests for extracted pure rules and service boundaries.
- **Unit suite CPU time dropped by 16.4%** (`520.1 s` → `434.6 s` `user + sys`), and **combined unit + integration CPU time dropped by 12.8%** (`583.1 s` → `508.7 s`), primarily by extracting repository seams and moving non-workerd tests out of `@cloudflare/vitest-plugin` into the Node pool (`workers/state`, `workers/api`, `workers/automation`) while preserving exact Istanbul coverage thresholds.
- **Repository seams & black-box provider route tests landed**:
  - `packages/reporting`: `ReportingRepository` seam + direct `service.test.ts`, `usage.test.ts`, `contracts.test.ts`.
  - `packages/providers`: configurable provider origin overrides (`PROVIDER_ORIGIN_*`) enabling real-adapter local HTTP fake testing without network access.
  - `workers/api`: `TenantRepository`, `BrandProfileRepository`, `PublishingPreferencesRepository`, `PublishingQueueRepository`, `BroadcastRepository`, `OAuthConnectionRepository` seams with typed fakes, dual Postgres+Fake round-trip tests (`brand-profile-repository`, `publishing-preferences-repository`, `publishing-queue-repository`, `publishing-queue-store`, `tenant-repository`), and a black-box HTTP route integration suite against a local fake TikTok server (`provider-route.integration.test.ts`).
  - `workers/automation`: `OutboxRepository`, `AccountAnalyticsRepository`, `RetentionRepository`, `UsageReconciliationRepository` seams with typed fakes and dual Postgres+Fake round-trip tests (`outbox-repository.integration.test.ts`).
  - `workers/state`: pure `oauth-state-rules.ts` extracted from the Durable Object (`72` fast Node tests alongside `12` Durable Object SQLite tests).
- **All pre-existing flaky and order-dependent tests were fixed**: every package and integration suite passes both in default order and under `--sequence.shuffle`, and sampled/rewritten tests across every workspace pass one at a time.
- **Remaining over-budget items**: documented in [Over budget](#over-budget) with measured times, confirmed causes, and fixes (including one security-relevant decision for the user: Better Auth's production `scrypt` password hashing cost in `packages/auth/test/index.test.ts`).

## How it was run

- Runtime & toolchain: `bun` (replacing `pnpm`) and Vite+ Vitest (`bunx --no-install vp test run`).
- Scope: all TypeScript tests in `frontend/`, `packages/`, and `workers/`. Vendored `.agents/` tests, Playwright specs (`frontend/app/e2e/`), and `.mjs`/`.sh` script tests are excluded from the refactor scope and listed separately below.
- Base commit: `43fba6a`. Final commit before this report: `9040b2b`.
- All integration runs used an isolated disposable PostgreSQL container on `127.0.0.1:5545` (`meltiply-ts-api-data`, removed after verification); ports `5433` and `5432` were never touched during final runs.
- Machine: 4-core Linux host; treat single-pass wall times as approximate and rely on CPU time (`user + sys`) and 3-run medians for over-budget diagnosis.

## Suite CPU time and test count

| Metric                                                            | Before (`43fba6a`) | After (`9040b2b`) | Delta            |
| ----------------------------------------------------------------- | ------------------ | ----------------- | ---------------- |
| `bun run test` CPU (`user + sys`)                                 | 520.1 s            | 434.6 s           | -85.5 s (-16.4%) |
| `bun run test:integration` CPU (`user + sys`, DB server excluded) | 63.0 s             | 74.1 s            | +11.1 s (+17.6%) |
| Combined CPU (`user + sys`)                                       | 583.1 s            | 508.7 s           | -74.4 s (-12.8%) |
| Unit / contract / component tests (`bun run test`)                | 2,283              | 5,333             | +3,050 (+133.6%) |
| Integration tests (`bun run test:integration`)                    | 452                | 671               | +219 (+48.5%)    |
| Total executed tests (excluding 8 intentional skips)              | 2,735              | 6,004             | +3,269 (+119.5%) |
| Test files                                                        | 197                | 264               | +67              |

## Category tables

All 264 final test files are explicitly classified (zero `Unclassified` files). **Total** and **Time share** include **Setup**; **Avg per test** and **Over budget** use each test's own duration (using 3-run medians where rerun).

### `packages/auth`

Before

| Category        | Total   | Setup  | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------ | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (real) | 1.6 sec | 437 ms | 100.0%     | 11    | 110 ms       | 50 ms  | 1           | 9.1%          |
| All             | 1.6 sec | 437 ms | 100.0%     | 11    | 110 ms       | —      | 1           | 9.1%          |

After (3-run median on `test/index.test.ts` and `test/verifiers.test.ts`)

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 380 ms  | 304 ms  | 6.9%       | 37    | 2.1 ms       | 5 ms   | 5           | 13.5%         |
| Services (fakes) | 588 ms  | 405 ms  | 10.6%      | 25    | 7.3 ms       | 5 ms   | 3           | 12.0%         |
| Services (real)  | 4.6 sec | 1.7 sec | 82.5%      | 28    | 101 ms       | 50 ms  | 11          | 39.3%         |
| All              | 5.5 sec | 2.4 sec | 100.0%     | 90    | 34 ms        | —      | 19          | 21.1%         |

### `packages/contracts`

Before

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Contract checks | 7.1 sec | 4.1 sec | 100.0%     | 23    | 132 ms       | —      | —           | —             |
| All             | 7.1 sec | 4.1 sec | 100.0%     | 23    | 132 ms       | —      | —           | —             |

After

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Contract checks | 4.3 sec | 4.1 sec | 100.0%     | 161   | 0.7 ms       | —      | —           | —             |
| All             | 4.3 sec | 4.1 sec | 100.0%     | 161   | 0.7 ms       | —      | —           | —             |

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
| Pure functions       | 35 ms   | 30 ms   | 0.8%       | 12    | 0.5 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes)     | 519 ms  | 498 ms  | 11.8%      | 22    | 0.9 ms       | 5 ms   | 1           | 4.5%          |
| Database round trips | 3.8 sec | 1.8 sec | 87.4%      | 25    | 83 ms        | 50 ms  | 8           | 32.0%         |
| All                  | 4.4 sec | 2.3 sec | 100.0%     | 59    | 35 ms        | —      | 9           | 15.3%         |

### `packages/domain`

Before

| Category       | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions | 2.0 sec | 2.0 sec | 100.0%     | 49    | 1.4 ms       | 5 ms   | 2           | 4.1%          |
| All            | 2.0 sec | 2.0 sec | 100.0%     | 49    | 1.4 ms       | —      | 2           | 4.1%          |

After

| Category       | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions | 1.9 sec | 1.8 sec | 100.0%     | 192   | 0.6 ms       | 5 ms   | 5           | 2.6%          |
| All            | 1.9 sec | 1.8 sec | 100.0%     | 192   | 0.6 ms       | —      | 5           | 2.6%          |

### `packages/observability`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 2.5 sec | 2.3 sec | 100.0%     | 30    | 4.2 ms       | 5 ms   | 4           | 13.3%         |
| All              | 2.5 sec | 2.3 sec | 100.0%     | 30    | 4.2 ms       | —      | 4           | 13.3%         |

After

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 523 ms  | 425 ms  | 16.0%      | 106   | 0.9 ms       | 5 ms   | 4           | 3.8%          |
| Services (fakes) | 2.8 sec | 2.6 sec | 84.0%      | 50    | 2.9 ms       | 5 ms   | 10          | 20.0%         |
| All              | 3.3 sec | 3.0 sec | 100.0%     | 156   | 1.6 ms       | —      | 14          | 9.0%          |

### `packages/providers`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 1.7 sec | 1.6 sec | 19.6%      | 58    | 0.9 ms       | 5 ms   | 0           | 0.0%          |
| Services (fakes) | 6.8 sec | 5.2 sec | 80.4%      | 304   | 5.3 ms       | 5 ms   | 16          | 5.3%          |
| All              | 8.5 sec | 6.9 sec | 100.0%     | 362   | 4.6 ms       | —      | 16          | 4.4%          |

After

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 8.7 sec  | 8.3 sec  | 55.9%      | 1,012 | 0.4 ms       | 5 ms   | 3           | 0.3%          |
| Services (fakes) | 6.9 sec  | 6.2 sec  | 44.1%      | 595   | 1.1 ms       | 5 ms   | 12          | 2.0%          |
| All              | 15.5 sec | 14.5 sec | 100.0%     | 1,607 | 0.6 ms       | —      | 15          | 0.9%          |

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
| Pure functions   | 2.0 sec | 1.9 sec | 60.5%      | 182   | 0.3 ms       | 5 ms   | 1           | 0.5%          |
| Services (fakes) | 1.3 sec | 1.2 sec | 39.5%      | 35    | 2.8 ms       | 5 ms   | 6           | 17.1%         |
| All              | 3.3 sec | 3.2 sec | 100.0%     | 217   | 0.7 ms       | —      | 7           | 3.2%          |

### `packages/secrets`

Before

| Category         | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 1.1 sec | 1.1 sec | 100.0%     | 6     | 4.7 ms       | 5 ms   | 1           | 16.7%         |
| All              | 1.1 sec | 1.1 sec | 100.0%     | 6     | 4.7 ms       | —      | 1           | 16.7%         |

After

| Category         | Total  | Setup  | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | ------ | ------ | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (fakes) | 513 ms | 491 ms | 100.0%     | 24    | 1 ms         | 5 ms   | 0           | 0.0%          |
| All              | 513 ms | 491 ms | 100.0%     | 24    | 1 ms         | —      | 0           | 0.0%          |

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
| Pure functions   | 1.5 sec | 1.4 sec | 39.4%      | 118   | 0.9 ms       | 5 ms   | 2           | 1.7%          |
| Services (fakes) | 2.3 sec | 2.1 sec | 60.6%      | 176   | 1 ms         | 5 ms   | 2           | 1.1%          |
| All              | 3.8 sec | 3.5 sec | 100.0%     | 294   | 1 ms         | —      | 4           | 1.4%          |

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

After (3-run median on the 3 remaining workerd runtime files)

| Category             | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions       | 3.0 sec  | 2.7 sec  | 1.7%       | 203   | 1.2 ms       | 5 ms   | 5           | 2.5%          |
| Services (fakes)     | 7.6 sec  | 6.9 sec  | 4.3%       | 221   | 3.3 ms       | 5 ms   | 33          | 14.9%         |
| Services (real)      | 940 ms   | 617 ms   | 0.5%       | 3     | 108 ms       | 50 ms  | 3           | 100.0%        |
| Route handlers       | 2m 17sec | 39.4 sec | 77.6%      | 494   | 197 ms       | 100 ms | 209         | 42.3%         |
| Database round trips | 24.2 sec | 3.5 sec  | 13.7%      | 224   | 93 ms        | 50 ms  | 89          | 39.7%         |
| Contract checks      | 3.7 sec  | 1.9 sec  | 2.1%       | 289   | 6.2 ms       | —      | —           | —             |
| All                  | 2m 56sec | 55.0 sec | 100.0%     | 1,434 | 85 ms        | —      | 339         | 29.6%         |

### `workers/automation`

Before

| Category         | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| ---------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions   | 16.1 sec | 16.1 sec | 14.5%      | 13    | 2.3 ms       | 5 ms   | 1           | 7.7%          |
| Services (fakes) | 1m 14sec | 1m 13sec | 66.7%      | 168   | 5 ms         | 5 ms   | 26          | 15.5%         |
| Services (real)  | 11.7 sec | 7.0 sec  | 10.6%      | 73    | 65 ms        | 50 ms  | 34          | 46.6%         |
| Route handlers   | 9.1 sec  | 1.3 sec  | 8.2%       | 74    | 105 ms       | 100 ms | 16          | 21.6%         |
| All              | 1m 51sec | 1m 38sec | 100.0%     | 328   | 41 ms        | —      | 77          | 23.5%         |

After (3-run median on `test/worker.test.ts`)

| Category             | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| -------------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions       | 3.0 sec  | 2.9 sec  | 7.3%       | 30    | 2.1 ms       | 5 ms   | 3           | 10.0%         |
| Services (fakes)     | 21.2 sec | 20.3 sec | 51.3%      | 183   | 4.7 ms       | 5 ms   | 34          | 18.6%         |
| Services (real)      | 9.2 sec  | 5.3 sec  | 22.4%      | 73    | 54 ms        | 50 ms  | 31          | 42.5%         |
| Route handlers       | 7.4 sec  | 1.1 sec  | 18.0%      | 74    | 85 ms        | 100 ms | 16          | 21.6%         |
| Database round trips | 466 ms   | 365 ms   | 1.1%       | 4     | 25 ms        | 50 ms  | 1           | 25.0%         |
| All                  | 41.3 sec | 30.1 sec | 100.0%     | 364   | 31 ms        | —      | 85          | 23.4%         |

### `workers/state`

Before

| Category        | Total   | Setup   | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | ------- | ------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Services (real) | 9.3 sec | 8.2 sec | 100.0%     | 19    | 57 ms        | 50 ms  | 5           | 26.3%         |
| All             | 9.3 sec | 8.2 sec | 100.0%     | 19    | 57 ms        | —      | 5           | 26.3%         |

After (3-run median on `test/oauth-state.test.ts`: `6.8 s` setup; single-pass saw a transient 19.2 s host spike)

| Category        | Total    | Setup    | Time share | Tests | Avg per test | Budget | Over budget | % over budget |
| --------------- | -------- | -------- | ---------- | ----- | ------------ | ------ | ----------- | ------------- |
| Pure functions  | 1.1 sec  | 962 ms   | 5.1%       | 72    | 1.5 ms       | 5 ms   | 7           | 9.7%          |
| Services (real) | 19.9 sec | 19.2 sec | 94.9%      | 12    | 61 ms        | 50 ms  | 6           | 50.0%         |
| All             | 21.0 sec | 20.1 sec | 100.0%     | 84    | 10 ms        | —      | 13          | 15.5%         |

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
| Pure functions   | 10.7 sec | 9.9 sec  | 7.7%       | 727   | 1.1 ms       | 5 ms   | 12          | 1.7%          |
| Services (fakes) | 21.1 sec | 18.4 sec | 15.2%      | 207   | 13 ms        | 5 ms   | 36          | 17.4%         |
| Web components   | 1m 47sec | 55.0 sec | 77.1%      | 388   | 134 ms       | —      | —           | —             |
| All              | 2m 19sec | 1m 23sec | 100.0%     | 1,322 | 42 ms        | —      | 48          | 5.1%          |

## Tests moved or removed

Every moved or removed test was verified by breaking the underlying production rule and watching the faster replacement fail.

| Test / file before                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`: `"yields and catches tagged errors in Effect.gen"`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Removed; tagged-error table in `packages/domain/test/index.test.ts` asserts every `_tag`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/domain/test/code-point-length.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Moved into `packages/domain/test/index.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/domain/test/assets.test.ts` (including property loop)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Replaced by `packages/domain/test/asset-policy.test.ts` with literal boundary cases (`packages/domain/src/asset-policy.ts` extracted & re-exported).                                                                                                                                                                                                                                                                                                                             |
| `packages/observability/test/index.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Split by subject into `correlation`, `effect-log-fields`, `log`, `otlp-payload`, `otlp`, `sampling`, `sanitize` tests.                                                                                                                                                                                                                                                                                                                                                           |
| `packages/providers/test/adapter-helpers.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Split into `failures.test.ts`, `results.test.ts`, `values.test.ts`; `codePointLength` covered by `packages/domain/test/index.test.ts`.                                                                                                                                                                                                                                                                                                                                           |
| `packages/reporting/test/transport.test.ts` (local HTTP server & config cases)                                                                                                                                                                                                                                                                                                                                                                                                                                           | Moved onto an injected fake `fetch` (asserting `redirect: "manual"`); configuration cases moved to `packages/reporting/test/configuration.test.ts`.                                                                                                                                                                                                                                                                                                                              |
| `packages/storage/test/index.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Split by source module into `encoding`, `keys`, `object-store`, `r2`, `service`, `sigv4` tests with typed fakes (`fake-object-store.ts`, `fake-r2-bucket.ts`).                                                                                                                                                                                                                                                                                                                   |
| `frontend/app/src/components/devbox/dev-box.test.tsx` (pseudo-locale test)                                                                                                                                                                                                                                                                                                                                                                                                                                               | Removed; covered directly by `frontend/app/src/lib/pseudo-locale.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `frontend/app` component-embedded logic tests (palette layout, i18n, theme, composer content, calendar month entries, compact totals)                                                                                                                                                                                                                                                                                                                                                                                    | Pushed down to pure tests: `brand-profile-palette-layout.test.ts`, `i18n-translate.test.ts`, `theme-resolve.test.ts`, `composer-content.test.ts`, `calendar-month-entries.test.ts`, `analytics-helpers.test.ts`.                                                                                                                                                                                                                                                                 |
| `workers/state/test/oauth-state.test.ts` (7 pure OAuth state rule tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pushed down to Node in `workers/state/test/oauth-state-rules.node.test.ts` (72 pure tests); 12 Durable Object SQLite tests stay in `oauth-state.test.ts`.                                                                                                                                                                                                                                                                                                                        |
| `workers/api/test/core-routes.test.ts` (3 `"provider publish option platform validation"` tests)                                                                                                                                                                                                                                                                                                                                                                                                                         | Removed after breakage check (`packages/providers/src/validator.ts` broke `packages/providers/test/validator.test.ts` in 13 ms).                                                                                                                                                                                                                                                                                                                                                 |
| `workers/api/test/*.test.ts` (22 zero-workerd files, including `app.test.ts` non-runtime cases, `core-routes`, `request-boundary`, `actor-resolution`, `publishing-domain`, `broadcast-control`, `current-user`, `current-user-effect`, `operator-routes`, `reporting-routes`, `outbox-relay`, `inbox-comment-sync`, `mail`, `runtime`, `token-credentials`, `verifier-cache`, `validation`, `idempotent-response`, `flow-observability`, `diagnostic-reporting`, `object-storage-provider`, `publication-requirements`) | Moved from `@cloudflare/vitest-plugin` (workerd) to Node in `workers/api/test/*.node.test.ts` (`vitest.contract.config.ts`, 30 files / 926 tests; Istanbul thresholds preserved). Only 3 genuine workerd runtime files (13 tests) remain in `vitest.config.ts`: `app.test.ts` (including 2 oversized `Response.clone()` tee-cancel probe tests that depend on workerd stream-cancel semantics), `provider-http-runtime.test.ts`, and `publication-requirements-runtime.test.ts`. |
| `workers/api` Postgres integration tests duplicating publishing preferences/queues/brand-profile validation rules                                                                                                                                                                                                                                                                                                                                                                                                        | Pushed down to Node pure/service tests (`brand-profile-rules`, `brand-profile-service`, `publishing-preferences-rules`, `publishing-preferences-service`, `publishing-queue-rules`, `publishing-queue-service`, `queue-schemas`) backed by dual Postgres+Fake repository round-trip tests.                                                                                                                                                                                       |
| `workers/automation/test/*.test.ts` (18 zero-workerd files: `account-analytics`, `asset-processing`, `channel-revocation`, `diagnostic-reporting`, `distribution-provider`, `effect-boundary`, `effect-services`, `flow-observability`, `object-storage-provider`, `outbox`, `outbox-routing`, `provider-credentials`, `provider-media`, `provider-sync-due`, `provider-sync-provider`, `reply-reconciliation`, `retention`, `usage`)                                                                                    | Moved from `@cloudflare/vitest-plugin` (workerd) to Node in `workers/automation/test/*.node.test.ts` (`vitest.node.config.ts`, 19 files / 194 tests; Istanbul thresholds preserved). Only `workers/automation/test/worker.test.ts` (19 tests exercising real Cloudflare `ScheduledController` / `waitUntil` / queue batch entrypoints) stays in workerd.                                                                                                                         |

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

| Time  | Test                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.6 s | `workers/api/test/query-budget.integration.test.ts` > core API PostgreSQL query budgets > holds statement and row counts constant for scaled core routes                                                             |
| 2.6 s | `workers/api/test/better-auth.integration.test.ts` > optional authenticator lifecycle > confirms enrollment, challenges sign-in, consumes backup codes once, regenerates and disables with password reauthentication |
| 2.3 s | `frontend/app/src/components/brand-profile-scope.test.tsx` > Posts surfaces > pages the cached grid without refetching and resets the page when filters change                                                       |
| 2.0 s | `workers/api/test/onboarding.integration.test.ts` > first-run bootstrap through the auth surface > applies the chosen Workspace name to the single canonical Workspace and resumes onboarding                        |
| 1.9 s | `workers/api/test/core-service.integration.test.ts` > Worker core service with PostgreSQL RLS > keeps upload quota writes below the accepted local p95 latency budget                                                |
| 1.6 s | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > accepts community uploads and processing beyond finite-policy allowances                                      |
| 1.5 s | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > never mints a single-PUT grant past the recorded deadline when signing stalls across a cancel                 |
| 1.4 s | `workers/api/test/upload-quota.integration.test.ts` > workspace storage Entitlements with PostgreSQL > preserves the authoritative Post when an upload, save, or schedule is rejected                                |
| 1.2 s | `workers/api/test/post-media-lifecycle.integration.test.ts` > post-owned media retention with PostgreSQL > reclaims a completed upload that was never attached once its seven days elapse                            |
| 1.2 s | `workers/api/test/post-media-lifecycle.integration.test.ts` > post-owned media retention with PostgreSQL > protects media for a retry window and for an ambiguous outcome awaiting reconciliation                    |

(`packages/contracts/test/examples.test.ts` dropped from `2.2 s` to `< 1 ms` per test after compiling OpenAPI schemas once in setup and splitting into one example per test.)

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

| Time            | File                                                                 |
| --------------- | -------------------------------------------------------------------- |
| 16.6 s (8.9 s)  | `frontend/app/src/components/composer/composer.test.tsx`             |
| 15.5 s (1.5 s)  | `workers/api/test/core-service.integration.test.ts`                  |
| 14.6 s (727 ms) | `workers/api/test/post-media-lifecycle.integration.test.ts`          |
| 14.4 s (12.2 s) | `frontend/app/src/preview/handlers.test.ts`                          |
| 14.2 s (14.1 s) | `workers/api/test/app.test.ts` (3-run median setup; 7 runtime tests) |
| 13.9 s (10.8 s) | `frontend/app/src/components/composer/schedule-date-time.test.tsx`   |
| 12.6 s (2.0 s)  | `frontend/app/src/components/brand-profile-scope.test.tsx`           |
| 11.2 s (1.2 s)  | `workers/api/test/better-auth.integration.test.ts`                   |
| 10.9 s (913 ms) | `workers/api/test/brand-profile-repository.integration.test.ts`      |
| 10.8 s (1.7 s)  | `workers/api/test/onboarding.integration.test.ts`                    |

(`workers/api/test/core-routes.test.ts` dropped out of the top 10 completely after moving to Node as `core-routes.node.test.ts`, and `workers/api/test/device-auth.integration.test.ts` dropped out after eliminating the 119-request rate-limit polling loop.)

## Over budget

368 of 2,735 tests (13.5%) and 179 of 197 files were over budget before; 558 of 6,004 tests (9.3%) and 220 of 264 files are over budget after. The increase in absolute over-budget count comes from adding 224 new Postgres+Fake database round-trip tests and 17 new `packages/auth` Better Auth `scrypt` tests; every pure-function and fake-service package dropped sharply in over-budget rate (e.g., `packages/providers` 4.4% → 0.9%, `packages/storage` 10.4% → 1.4%, `frontend/app` 13.3% → 5.1%).

| Group                                                                                                                                                                                                                                                                                                                           | Count & typical / max time                                                                                                                                                                                                                                                                                                                                         | Confirmed cause                                                                                                                                                                                                                            | Change that would fix it                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/auth/test/index.test.ts` (Services, real; 50 ms budget)                                                                                                                                                                                                                                                               | 11 tests; 3-run medians 88 ms–261 ms (sign-up ~89 ms, password change ~180 ms, reset-password + sign-in 261 ms)                                                                                                                                                                                                                                                    | Better Auth runs production `scrypt` password hashing (~85 ms per hash/verify call) on every sign-up, sign-in, and password change.                                                                                                        | **Needs user decision (security-relevant):** inject a fast test-only password hasher option in `createBetterAuth` (production keeps default `scrypt`). Not changed unilaterally because password-hasher settings are security-sensitive.   |
| 5 remaining Cloudflare `workerd` runtime files (`workers/api`: `app.test.ts` 14.1 s median setup, `publication-requirements-runtime.test.ts` 9.6 s median setup; `workers/automation`: `worker.test.ts` 8.1 s median setup, 99 ms max test; `workers/state`: `oauth-state.test.ts` 6.8 s median setup, 6 tests 51–68 ms median) | 5 files; 6–34 tests                                                                                                                                                                                                                                                                                                                                                | `@cloudflare/vitest-plugin` Miniflare/workerd isolate boot, module transform, and Durable Object SQLite storage I/O. (`fsModuleCache: true` fails in workerd with `readAll .vitest-cache` errors.)                                         | Upstream `@cloudflare/vitest-plugin` transform caching; already minimized to the 5 files that genuinely require `workerd` bindings (`exports.default.fetch`, `waitUntil`, Durable Object SQLite, `Response.clone()` tee-cancel semantics). |
| Real PostgreSQL route handlers & services (`workers/api`, `workers/automation`, `packages/database` integration suites)                                                                                                                                                                                                         | 209 `workers/api` route tests (max 8.6 s `query-budget`, 2.6 s `better-auth` TOTP, 2.0 s `onboarding`), 31 `workers/automation` real-service tests (max 181 ms), 16 `assets.integration.test.ts` tests (max 493 ms), 8 `packages/database` round trips (max 1.1 s `migration-012`), 89 `workers/api` repository round trips (max 1.2 s `brand-profile-repository`) | Multi-request HTTP/SQL arrangement per test against live PostgreSQL with RLS transactions, `scrypt` auth sign-ups (`better-auth`, `onboarding`), and full schema migration replay (`migration-012`).                                       | Snapshot a pre-seeded database template (`CREATE DATABASE ... TEMPLATE`) or transaction-rollback harness per test, and accept a test-only password hasher for HTTP auth integration tests.                                                 |
| `frontend/app` preview & catalog/service tests (`src/preview/handlers.test.ts`, `src/lib/i18n.catalog.test.ts`, `eslint-boundaries.test.ts`, `upload.test.ts`)                                                                                                                                                                  | 12 pure tests (max 340 ms `i18n.catalog.test.ts`), 36 fake-service tests (max 234 ms `handlers.test.ts`), plus jsdom file setup (8.9 s–12.2 s on top files)                                                                                                                                                                                                        | `i18n.catalog.test.ts` scans the full source tree with regex/AST checks; `handlers.test.ts` validates full OpenAPI request/response bodies through Ajv on every preview request; Vite+jsdom creates a fresh DOM and module graph per file. | Split non-DOM unit tests into a Node Vitest project (no jsdom), cache compiled OpenAPI preview validators across tests, and narrow barrel imports.                                                                                         |
| File setup across Node `packages/*` and `workers/*` (100 ms file budget)                                                                                                                                                                                                                                                        | ~185 Node files (typically 200 ms–1.5 s setup)                                                                                                                                                                                                                                                                                                                     | Vitest worker boot, TypeScript transform, and V8/Istanbul coverage instrumentation per file exceed the 100 ms per-file floor even when tests inside take `< 1 ms`.                                                                         | Combine tiny single-module test files or measure per-file setup without coverage enabled (`--coverage.enabled=false`).                                                                                                                     |
| Residual 5–48 ms unit/fake tests across `packages/*`, `workers/api/*.node.test.ts`, `workers/automation/*.node.test.ts`, `workers/state/*.node.test.ts`                                                                                                                                                                         | 1–33 tests per package (typically 5–16 ms, max 48 ms `broadcast-service.node.test.ts`)                                                                                                                                                                                                                                                                             | First-test JIT/WebCrypto/Effect-layer/Zod schema warm-up and 4-core CPU jitter under V8/Istanbul instrumentation.                                                                                                                          | Move first-call Zod/WebCrypto/Effect warm-up into `beforeAll` on the remaining warm-up files.                                                                                                                                              |

## Duplicates and slow tests outside the scope

### Duplicates outside the scope

| Out-of-scope test                                                                                                                                                                                            | Faster in-scope test covering the same rule                                     | Notes                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `frontend/app/e2e/posts-composer.spec.ts` ("has no Media navigation and treats /media as an unknown route") & `frontend/app/e2e/real-stack.spec.ts` ("retired route /media follows unknown-route behaviour") | `frontend/app/src/app/app.test.tsx` & `frontend/app/src/lib/navigation.test.ts` | Left untouched as real-browser / real-stack smoke checks. |
| `frontend/app/e2e/real-stack.spec.ts` ("keeps public registration closed after the owner exists")                                                                                                            | `workers/api/test/onboarding.integration.test.ts`                               | Left untouched as a full-stack deployment smoke test.     |

### Slow tests outside the scope or owned by another runner

Left untouched as required:

- **Playwright E2E suite (16 specs, 71 tests)** in `frontend/app/e2e/`: `analytics.spec.ts`, `auth.spec.ts`, `device-consent.spec.ts`, `invitation-journey.spec.ts`, `onboarding-reporting.spec.ts`, `performance.spec.ts`, `posts-composer.spec.ts`, `posts-publication.spec.ts`, `public-site.spec.ts`, `publishing-preferences.spec.ts`, `publishing-queues.spec.ts`, `real-stack.spec.ts`, `shared-components.spec.ts`, `staging-smoke.spec.ts`, `workspace-design.spec.ts`, `workspace-roles.spec.ts`.
- **Node/Shell script & lint tests (44 files)**: `lint/*.test.mjs` (2), `packages/contracts/scripts/*.test.mjs` (2), `scripts/ci/*.test.{mjs,sh}` (11), `scripts/cloudflare-local/*.test.{mjs,sh}` (10), `scripts/i18n/*.test.mjs` (4), `scripts/infra/*.test.mjs` (7), `scripts/release/*.test.mjs` (11), `scripts/selfhost/*.test.mjs` (2), `scripts/staging/*.test.mjs` (1).
- **Vendored `.agents/` tests**: excluded from scope.

## Bugs and test problems found

### Product / dependency behaviors pinned (not fixed)

Per guardrails, product/dependency behavior bugs found during refactoring were not fixed; each has a passing pin for today's behavior and a skipped red test for the expected behavior:

1. **`frontend/app/src/lib/format.test.ts` (`formatDuration(-1)`)**: returns `"-1:59"` today (pinned in passing test) instead of `"-0:01"` (`it.skip("a negative duration (bug: should read -0:01)")`).
2. **`packages/storage/test/sigv4.test.ts` (`SigV4Signer` IPv6 loopback)**: rejects plain `http://[::1]:9000` today (pinned in passing test) instead of allowing IPv6 loopback like `127.0.0.1` and `localhost` (`it.skip("plain http on the IPv6 loopback (bug: should be accepted as loopback)")`).
3. **`packages/auth/test/index.test.ts` (Better Auth `trustedOrigins` under Vitest)**: `better-auth@1.7.5` (`dist/context/create-context.mjs:211`) defaults `skipOriginCheck` to `isTest() ? true : false`, so `POST /api/auth/sign-out` from an untrusted `Origin` returns `200` under `NODE_ENV=test` / Vitest unless `advanced.disableOriginCheck: false` is set explicitly. Pinned today's behavior with a passing test and added `it.skip("rejects state-changing requests from an untrusted origin even in test runs")`. (Password-reset session revocation and disabled session cookie caching were verified and pass cleanly in `packages/auth/test/index.test.ts`.)

### Pre-existing test infrastructure & isolation bugs fixed

1. **Five integration files hardcoded development Postgres port `5433`**: ignored `MELTIPLY_DATABASE_TEST_URL`. Updated to derive URLs from `MELTIPLY_DATABASE_TEST_URL` / `MELTIPLY_DATABASE_TEST_ADMIN_URL` (`b0fc183`).
2. **Flaky rate-limit window rollover in `workers/api/test/device-auth.integration.test.ts`**: `"counts per-device throttled polls against the caller ceiling before a new code can allocate a bucket"` previously sent 119 sequential HTTP polls that spanned 5 s / 60 s `date_bin` boundaries. Replaced with 1 live poll, advancing `auth_rate_limits.attempt_count` to `117`, 3 real throttled `slow_down` polls, and 1 distinct-code poll hitting the 120/min caller ceiling (`01dc499`).
3. **Order-dependent unit test in `workers/automation/test/worker.test.ts`**: `"Scheduled entry delayed delivery"` failed when shuffled because earlier `handler.scheduled` tests did not `await waitOnExecutionContext(ctx)`, letting diagnostic `waitUntil` promises leak `withSystemTransactionEffect` calls into later tests. Awaited `waitOnExecutionContext(ctx)` on every `handler.scheduled` call and isolated `sweepDue` (`18f6efe`).
4. **Order-dependent integration tests across 5 files (all reproduced on `43fba6a`, now fixed & passing across multiple shuffle seeds)**:
   - `workers/api/test/upload-quota.integration.test.ts` (1 test): `seedResidentInventory` placed baseline assets in the current UTC month (`now() - INTERVAL '3 days'`), causing `runMaintenance()` reconciliation to exceed `max_uploads: 10`; anchored timestamps to the prior month (`date_trunc('month', now() AT TIME ZONE 'UTC') - INTERVAL '3 days'`).
   - `workers/api/test/core-service.integration.test.ts` (2 tests): `"accepts one durable reply"` left seeded comment `80000000-...-0001` in `reply_status = 'queued'`; restored `reply_status = 'none'` in `try/finally`.
   - `workers/automation/test/retention.integration.test.ts` (1 test): moved 6-group retention seeding out of `beforeAll` into `seedRetentionRows()` inside `"deletes bounded old rows"`.
   - `workers/automation/test/distribution.integration.test.ts` (1 test): made `"recovers a stalled attempt through a reconciliation trigger"` self-contained with `resetCompositions()` and its own seeded rows.
   - `workers/automation/test/assets.integration.test.ts` (11+ tests): added `beforeEach` cleanup of stray non-baseline `outbox_events`, `automationDistributionFixtureIds`, and `rate_limit_budgets`, switched `2026-07` `usage_records` fixture setup to `INSERT ... ON CONFLICT DO UPDATE`, and restored `platform_accounts` test tokens after sync/refresh mutations (`01dc499`, `9040b2b`).
5. **Pre-existing direct-path lint note**: `packages/contracts/test-support/validation.ts` is outside its package tsconfig include, so linting it directly by path triggers a type-aware project error while repo-wide `bun run lint` passes cleanly with 0 warnings.

## Verification

| Check                                                      | Command                                                                                                                                                        | Outcome                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Formatting (Cloudflare subset)                             | `bun run format-check:cloudflare`                                                                                                                              | Pass (553 files)                                                             |
| Formatting (repo-wide)                                     | `bun x vp fmt --check`                                                                                                                                         | Pass (1,113 files)                                                           |
| Lint + Astro UI contract + migration lock                  | `bun run lint`                                                                                                                                                 | Pass (0 warnings, 0 errors across 936 files)                                 |
| Dead code                                                  | `bun run lint:dead`                                                                                                                                            | Pass (`knip`: no issues)                                                     |
| Type check                                                 | `bun x vp run -r type-check`                                                                                                                                   | Pass (all 14 workspaces)                                                     |
| Unit / contract / component suite                          | `/usr/bin/time -p bun run test`                                                                                                                                | Pass (`real 213.36s, user 373.07s, sys 61.54s`, CPU `434.61s`; 5,333 passed) |
| Integration suite (disposable Postgres `5545`)             | `/usr/bin/time -p bun run test:integration`                                                                                                                    | Pass (`real 174.71s, user 60.74s, sys 13.39s`, CPU `74.13s`; 671 passed)     |
| Shuffled across all 13 packages & all 3 integration suites | `vp test run --sequence.shuffle --coverage.enabled=false` (plus 3 distinct seeds `1795668712487`, `42424242`, `987654321` on `workers/automation` integration) | Pass (0 failures across all 6,004 tests)                                     |
| One at a time (`-t "^<name>$"`)                            | 108 sampled tests spanning all 13 workspaces + Postgres route/repository round trips (in addition to 565 earlier rewritten-file isolated runs)                 | Pass (108/108 + 565/565, 0 problems)                                         |
| Disposable Postgres cleanup                                | `docker rm -f meltiply-ts-api-data`                                                                                                                            | Removed cleanly                                                              |

Nothing has been pushed to any remote.
