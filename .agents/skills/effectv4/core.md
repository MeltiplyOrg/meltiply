# Core Effect v4 idioms

Applies to backend and frontend. `effect@4.0.5` is the single version; core carries zero external dependencies.

## Effect type

`Effect<A, E, R>` is a lazy program value: `A` success, `E` typed failure, `R` required services. It runs only at an approved boundary (`Effect.runPromise`, `runPromiseExit`, `runFork`, `runSync` for pure sync). Read `R` as the dependency contract: `never` means standalone.

Two failure kinds share one Cause but different channels. Typed failures (`Effect.fail`, yielded `Data.TaggedError`) land in `E` and are recoverable with `catch` / `catchTag`. Defects (thrown exceptions, `Effect.die`, throws inside `sync` / `promise`) bypass `E` and are visible only through `Cause` / `Exit` at a boundary. The standing rule: expect typed failures in business logic, handle defects only at boundaries.

## gen programs

Write sequential logic with `Effect.gen`:

```ts
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const user = yield* getCurrentUser();
  if (!user.workspaceId)
    return yield* Effect.fail(
      new ActiveOrganizationRequiredError({ message: "Sign in to a workspace" }),
    );
  return yield* loadCalendar(user.workspaceId);
});
```

Use plain control flow inside `gen`; make failure explicit with `return yield* Effect.fail(...)` so narrowing holds. Reserve `pipe` composition (`map`, `flatMap`, `andThen`, `tap`) for short pipelines outside `gen`. Prefer `yield* Service` over `Service.use` so dependencies stay visible in `R`. Name traced service methods with `Effect.fn("Service.method")` so spans carry the operation name without manual span plumbing.

## Services

Define one tag per collaborator with `Context.Service` and a `readonly` shape whose methods carry `R = never`:

```ts
import { Context, Effect, Layer } from "effect";

export interface SecretServiceShape {
  readonly decrypt: (
    ciphertext: string,
  ) => Effect.Effect<string, StorageUnavailableError | InvalidRequestError>;
  readonly encrypt: (
    plaintext: string,
  ) => Effect.Effect<string, StorageUnavailableError | InvalidRequestError>;
}

export class SecretService extends Context.Service<SecretService, SecretServiceShape>()(
  "SecretService",
) {}
```

Use unique string IDs. Shape example lives in `packages/secrets/src/index.ts`; request metadata tag lives in `packages/domain/src/effect/context.ts` (`RequestContext`). Keep provider-specific branching inside the service implementation (`packages/providers` resolves platforms behind `ProviderService`); callers select a platform and compose Effects without per-provider conditionals.

## Layers

Build the object graph once, provide it once at the boundary:

- `Layer.succeed` for a ready value, `Layer.effect` for construction needing services, `Layer.scoped` / `Effect.acquireRelease` for lifecycle.
- Compose with `Layer.mergeAll` (parallel) and `Layer.provide` (sequential); run with a single `Effect.provide(program, appLayer)`. Override one service in a composed graph with `Effect.provideService(program, Service, value)`, as `runFrontendEffect` does for `WorkspaceService`.
- Ship `createXServiceLive` plus `createXServiceTest` (see `packages/secrets`, `packages/storage`, `packages/auth`, `packages/database`). Tests provide the test Layer per test; unstubbed frontend operations die loudly (see `frontend/app/src/lib/effect/api-client.ts`).
- Store parameterized Layers in a `const`; inlining the constructor twice builds two pools. Reach for `Layer.fresh` or `Effect.provide(layer, { local: true })` only for deliberate isolation.
- Keep Layer construction free of heavy imports where tests must stay light: automation boundary modules stay pg-free and `pg` enters behind dynamic `import()`, so unit tests build scopes without loading the database client.

## Typed errors

Model recoverable failures as `Data.TaggedError` in `packages/domain/src/effect/errors.ts` with canonical `code` + `status` (example: `NotFoundError` → `not_found` / 404). Yield instances directly in `gen`; recover with `catchTag` / `catchTags` / `catch`. Keep `_tag` strings unique: collisions catch unrelated failures. Automation owns its own trio in `workers/automation/src/effect/job-errors.ts`: `RetryableJobError` (redeliver with backoff), `TerminalJobError` (poison: ack and surface diagnostics, never burn retry budget), `AmbiguousJobError` (maybe-committed remote write: reconcile, never blind-retry).

Lift boundaries explicitly:

```ts
Effect.tryPromise({
  catch: (cause) =>
    new StorageUnavailableError({
      message: cause instanceof Error ? cause.message : "Failed to encrypt token",
    }),
  try: () => cipher.encrypt(plaintext),
});
```

`try` / `tryPromise` without `catch` degrade to `UnknownError`; `sync` / `promise` let throws escape as defects. Map invalid input to 4xx errors and infrastructure loss to 5xx errors at the lift site, matching `packages/storage/src/index.ts` (`TypeError|RangeError` → `InvalidRequestError`, else `StorageUnavailableError`). When a thunk can only fail one way, build the smallest adapter that names the operation, as `storageEffect` does in `workers/state/src/index.ts` (message plus underlying error name as `cause`). Preserve already-typed failures by returning them from `catch` and rethrowing the rest, as `fromPromise` does in `workers/api/src/effect/route.ts` and `providerCallEffect` does in `packages/providers/src/effect.ts`.

## Retries and schedules

Retry only what is safe to repeat. The repo rule: reads retry, writes never auto-retry (no provider proves a remote idempotency contract; a timeout after dispatch may follow an accepted write). Gate retries with a predicate plus a bounded schedule:

```ts
Effect.retry(effect, { schedule: readRetrySchedule(policy), while: isRetryableFailure });
```

`readRetrySchedule` (`packages/providers/src/effect.ts`) builds exponential backoff from the adapter policy (`Schedule.exponential(base)` capped at `maxDelaySeconds`, `Schedule.upTo({ times: maxAttempts - 1 })`); `isRetryableFailure` passes only `timeout | transient` failures. `rate_limit` stays retryable in classification but is excluded from inner retries: its `retryAfterSeconds` hint belongs to the outer scheduler (worker due-work parking, queue backoff `min(3600, 15 * 2^attempts)`), and an inner fixed backoff would compete with the provider's requested delay.

## Concurrency

Default to sequential `gen`; reach for parallelism only for independent work. Join unordered results with `Effect.all([...])` (asset fan-out in `workers/api`), and fork-then-join when one branch needs independent control: `Effect.forkChild` plus `Fiber.join` (provider retry test drives virtual time with `TestClock.adjust` while the forked read is in flight; upload multipart parts fan out as forked fibers joined with `Fiber.awaitAll`). Forward one `AbortSignal` into every branch so cancellation stays unified, and copy shared mutable context (provider metadata) back after settlement rather than sharing it across fibers.

## Cancellation and resources

Cancellation is first-class: every boundary forwards the caller `AbortSignal` into `runPromiseExit`, and `providerCallEffect` merges fiber and caller abort with `AbortSignal.any`. Treat `Cause.hasInterruptsOnly` as cancellation (client-abort vs server-interrupt), never as a domain failure. Acquire scarce resources with `Effect.acquireRelease` and scope them with `Effect.scoped` at the boundary (`runQueryEffect` runs `Effect.scoped(effect)`), so release runs on success, failure, and interruption. Rollback paths that must survive interruption get `Effect.uninterruptible`, as the database transaction rollback does; connection release itself goes in `Effect.ensuring` so it runs on every path.

## Cause and Exit at boundaries

`Exit` preserves the full outcome; `Cause.reasons` is a flat list of `Fail | Die | Interrupt`. Inspect in this order: `Cause.hasDies` → typed `Cause.findErrorOption` → `Cause.hasInterruptsOnly`. `Result` (not `Either`) carries the typed outcome; `Effect.exit` keeps defects and interrupts where `Effect.result` / `option` discard them. Automation's `exitToJobOutcome` shows the full mapping discipline: success → processed, dies → retry with diagnostics, interrupts-only → retry, `TerminalJobError` → rejected, `AmbiguousJobError` → ambiguous, everything else → retry. Copy the nearest boundary instead of inventing a new order.

## Observability

Name spans at service-method granularity (`Effect.fn` or `Effect.withSpan`), attach `effectLoggerLayer` / `effectTracerLayer` at the scope, and keep secrets out of log annotations. The Effect logger (`packages/observability/src/effect-logger.ts`) pipes Effect events into structured logging with redaction and fiber annotations; the tracer (`effect-tracer.ts`) forwards sampled spans to OTLP and registers exports with `executionCtx.waitUntil` so telemetry never delays the response. Log failures through `failureDiagnostic` / `errorDiagnostic` projections, never raw provider payloads or tokens.

## Testing

Test through the Layer seam, one Layer per test. Provide `createXServiceTest` doubles, drive time with `TestClock.adjust` for retry/schedule tests, and fork-then-join (`Effect.forkChild` + `Fiber.join`) when the test must advance the clock mid-flight. Extract typed failures with `Effect.match({ onFailure, onSuccess })` rather than converting Causes into telemetry. Keep boundary mapping modules dependency-light (automation boundary is pg-free) so mapping tests pin outcomes without loading infrastructure.

## Anti-patterns

- Leaking requirements in service methods (`query: (...) => Effect<..., ..., Config | Logger>`). Fix: `R = never` methods, dependencies in Layer construction.
- Scattering `provide` / `provideService` through business logic. Fix: compose the full layer once, single `Effect.provide` at the boundary.
- Using `use()` everywhere instead of `yield*`. Fix: `gen` keeps dependencies visible.
- Catching defects as domain errors (`catch` expecting to catch `die` / throws). Fix: typed channel plus `catchTag`; `catchDefect` / `catchCause` only at boundaries.
- Throwing in `sync` / `promise` constructors or omitting `catch` on `try` / `tryPromise`. Fix: explicit `catch` mapping to a domain error at every lift.
- Retrying writes or `rate_limit` inner retries. Fix: writes run once and reconcile; `429` propagates with its hint to the outer scheduler.
- Duplicating parameterized Layers inline. Fix: store in a `const`; shared memoization is a safety net, not a composition strategy.
- Global mutable test state (suite-shared Layers, module-level maps). Fix: per-test `provide` of test Layers.
- Building request-scoped Layers once globally with `env`, or never disposing them. Fix: build per request / message / invocation from the current `env`, dispose after.

## v4 migrations that bite

v3 idioms that no longer compile or silently change meaning: `Context.Tag` / `GenericTag` / `Effect.Service` with auto `Default` (now `Context.Service` plus explicit `Layer.effect(this, this.make)`), static service accessors (now `yield*`), `gen(function* (_) { yield* _(eff) })` (now `gen(function* () { yield* eff })`), `catchAll` / `catchSome` (now `catch` / `catchFilter`), `Cause` tree matching and `isFailure` / `failureOption` / `dieOption` (now `reasons` plus `hasDies` / `hasInterruptsOnly` / `findErrorOption`), `Either` (now `Result`), `FiberRef` (now `References`), `fork` (now `forkChild` / `forkDetach`), `Effect.Do` / `zipLeft` / `zipRight` (now `gen` / `tap` / `andThen`), `Scope.extend` (now `Scope.provide`). When porting, consult the upstream migration file for the module (`https://github.com/Effect-TS/effect/blob/main/MIGRATION.md`).

## Reference

- Effect type: https://effect.website/docs/v4/getting-started/the-effect-type
- Creating: https://effect.website/docs/v4/getting-started/creating-effects
- Generators: https://effect.website/docs/v4/getting-started/using-generators
- Running: https://effect.website/docs/v4/getting-started/running-effects
- Expected errors: https://effect.website/docs/v4/error-management/expected-errors
- Unexpected errors: https://effect.website/docs/v4/error-management/unexpected-errors
- Services: https://effect.website/docs/v4/requirements-management/services
- Layers: https://effect.website/docs/v4/requirements-management/layers
- Scope: https://effect.website/docs/v4/resource-management/scope
