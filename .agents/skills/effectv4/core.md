# Core Effect v4 idioms

Applies to backend and frontend. `effect@4.0.5` is the single version across the workspace; core carries zero external dependencies.

## Effect type

`Effect<A, E, R>` is a lazy program value: `A` success, `E` typed failure, `R` required services. It runs only at an approved boundary (`Effect.runPromise`, `runPromiseExit`, `runFork`, `runSync` for pure sync). Read `R` as the dependency contract: `never` means standalone.

Yieldable types: `Config` and `Context.Service` remain Effect subtypes and yield directly inside `Effect.gen`. In contrast, `Option`, `Result` (replaces v3 `Either`), `Ref`, and `Deferred` are plain values in v4 — convert explicitly via `Effect.fromOption`, `Effect.fromResult`, and `Ref.get` before yielding.

Two failure kinds share one Cause but different channels. Typed failures (`Effect.fail`, `Effect.failSync`, yielded `Data.TaggedError`) land in `E` and are recoverable with `catch` / `catchTag` / `catchFilter`. Defects (thrown exceptions, `Effect.die`, unhandled throws in `sync` / `promise`) bypass `E` and are visible only through `Cause` / `Exit` at a boundary. In v4, defects take precedence across all typed recovery operators: any cause containing a defect skips typed handlers and propagates. The standing rule: expect typed failures in business logic, handle defects only at boundaries.

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

Use plain control flow inside `gen`; make failure explicit with `return yield* Effect.fail(...)` so narrowing holds. Reserve `pipe` composition (`map`, `flatMap`, `andThen`, `tap`) for short pipelines outside `gen`. Prefer `yield* Service` over `Service.use` so dependencies stay visible in `R`. Name traced functions with `Effect.fn("Service.method")` so spans carry the operation name without manual span plumbing; use `Effect.fnUntraced` for untraced hot loops, or `Effect.withSpan` to wrap an existing effect.

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

Use unique string IDs. Shape example lives in `packages/secrets/src/index.ts`; request metadata tag lives in `packages/domain/src/effect/context.ts` (`RequestContext`). Optional effectful constructors use `make: Effect.gen(...)` on `Context.Service`, with the layer explicitly built via `Layer.effect(this, this.make)`. Context references with defaults (replacing v3 `FiberRef`) use `Context.Reference("Id", { defaultValue })`. Keep provider-specific branching inside the service implementation (`packages/providers` resolves platforms behind `ProviderService`); callers select a platform and compose Effects without per-provider conditionals.

## Layers

Build the object graph once, provide it once at the boundary:

- `Layer.succeed` for a ready value, `Layer.effect` for construction needing services, `Layer.scoped` / `Effect.acquireRelease` for lifecycle.
- Compose with `Layer.mergeAll(...layers)` (parallel) and `Layer.provide` (sequential); run with a single `Effect.provide(program, appLayer)`. Override one service in a composed graph with `Effect.provideService(program, Service, value)`, as `runFrontendEffect` does for `WorkspaceService`.
- Layer memoization in v4: nested `Effect.provide` calls reuse already-built layers from the ambient `MemoMap` (each call forks the map); sibling `provide` calls build independent copies. Use `Layer.fresh(layer)` or `Effect.provide(layer, { local: true })` to build a fresh subtree without reusing enclosing layers.
- Ship `createXServiceLive` plus `createXServiceTest` (see `packages/secrets`, `packages/storage`, `packages/auth`, `packages/database`). Tests provide the test Layer per test; unstubbed frontend operations die loudly (see `frontend/app/src/lib/effect/api-client.ts`).
- Store parameterized Layers in a `const`; inlining the constructor twice builds two pools.
- Keep Layer construction free of heavy imports where tests must stay light: automation boundary modules stay pg-free and `pg` enters behind dynamic `import()`, so unit tests build scopes without loading the database client.

## Typed errors

Model recoverable failures as `Data.TaggedError` in `packages/domain/src/effect/errors.ts` with canonical `code` + `status` (example: `NotFoundError` → `not_found` / 404). Yield instances directly in `gen`; recover with `catchTag` / `catchTags` / `catch` / `catchFilter` (replaces `catchSome`, takes `Filter`) / `catchReason` (for nested `reason` tags). Keep `_tag` strings unique: collisions catch unrelated failures. Automation owns its own trio in `workers/automation/src/effect/job-errors.ts`: `RetryableJobError` (redeliver with backoff), `TerminalJobError` (poison: ack and surface diagnostics, never burn retry budget), `AmbiguousJobError` (maybe-committed remote write: reconcile, never blind-retry).

Mixed-cause precedence: in v4, all typed-recovery operators (`catch`, `catchTag`, `catchTags`, `catchIf`, `catchFilter`, `catchReason`, `retry`, `match`) skip causes containing defects. The handler does not run, and the failure propagates with each typed error converted to a defect. Interruption alongside typed errors does not prevent recovery.

Error mapping: `Effect.mapError` transforms every typed error in place while preserving defects, interrupts, and reason order (not recovery: does not drop reasons or convert them).
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

`try` / `tryPromise` without `catch` degrade to `UnknownError`; `sync` / `promise` let throws escape as defects. Map invalid input to 4xx errors and infrastructure loss to 5xx errors at the lift site, matching `packages/storage/src/index.ts` (`TypeError|RangeError` → `InvalidRequestError`, else `StorageUnavailableError`). When a thunk can only fail one way, build the smallest adapter that names the operation, as `storageEffect` does in `workers/state/src/index.ts` (message plus underlying error name as `cause`). Preserve already-typed failures by returning them from `catch` and rethrowing the rest, as `fromPromise` does in `workers/api/src/effect/route.ts` and `providerCallEffect` does in `packages/providers/src/effect.ts`. Use `Effect.failSync` when constructing the failure value itself involves a side effect or should be deferred.

## Retries and schedules

Retry only what is safe to repeat. The repo rule: reads retry, writes never auto-retry (no provider proves a remote idempotency contract; a timeout after dispatch may follow an accepted write). Gate retries with a predicate plus a bounded schedule:

```ts
Effect.retry(effect, { schedule: readRetrySchedule(policy), while: isRetryableFailure });
```

`readRetrySchedule` (`packages/providers/src/effect.ts`) builds exponential backoff from the adapter policy (`Schedule.exponential(base)` capped at `maxDelaySeconds`, `Schedule.upTo({ times: maxAttempts - 1 })`); `isRetryableFailure` passes only `timeout | transient` failures. `rate_limit` stays retryable in classification but is excluded from inner retries: its `retryAfterSeconds` hint belongs to the outer scheduler (worker due-work parking, queue backoff `min(3600, 15 * 2^attempts)`), and an inner fixed backoff would compete with the provider's requested delay. `Retry.Options` also accepts `times`, `while`, and `until`. Defects and pure interruptions are never retried; in v4, a mixed `Fail + Interrupt` enters the typed retry path instead of propagating untouched.

## Concurrency

Default to sequential `gen`; reach for parallelism only for independent work. `Effect.all(effects)` is sequential by default; pass `{ concurrency: "unbounded" }` (or a concurrency bound) for parallel execution (e.g. outbox dispatch in `workers/automation/src/outbox.ts`). Fork-then-join when one branch needs independent control: `Effect.forkChild` (tied to parent fiber) or `Effect.forkDetach` (daemon fiber), accepting `{ startImmediately?: boolean, uninterruptible?: boolean | "inherit" }`. Join with `Fiber.join` or `Fiber.awaitAll` (provider retry test drives virtual time with `TestClock.adjust` while the forked read is in flight; upload multipart parts fan out as forked fibers joined with `Fiber.awaitAll`). Forward one `AbortSignal` into every branch so cancellation stays unified, and copy shared mutable context (provider metadata) back after settlement rather than sharing it across fibers.

## Cancellation and resources

Cancellation is first-class: every boundary forwards the caller `AbortSignal` into `runPromiseExit`, and `providerCallEffect` merges fiber and caller abort with `AbortSignal.any`. Treat `Cause.hasInterruptsOnly` as cancellation (client-abort vs server-interrupt), never as a domain failure. Acquire scarce resources with `Effect.acquireRelease` and scope them with `Effect.scoped` at the boundary (`runQueryEffect` runs `Effect.scoped(effect)`), so release runs on success, failure, and interruption. Add ad-hoc finalizers with `Effect.addFinalizer((exit) => ...)`. Provide scopes with `Scope.provide(scope)(effect)` or `Scope.provide(effect, scope)` (replaces v3 `Scope.extend`). Rollback paths that must survive interruption get `Effect.uninterruptible`, as the database transaction rollback does; connection release itself goes in `Effect.ensuring` so it runs on every path.

## Cause and Exit at boundaries

`Exit` preserves the full outcome; `Cause.reasons` is a flat list of `Fail<E> | Die | Interrupt` (no recursive tree). Check reasons with guards: `Cause.isFailReason`, `Cause.isDieReason`, `Cause.isInterruptReason`. Inspect causes in this order: `Cause.hasDies` → typed `Cause.findErrorOption` / `Cause.findError` → `Cause.hasInterruptsOnly`. `Cause.findDie` extracts the first defect. `Result` (replaces v3 `Either`) carries the typed outcome; `Effect.exit` keeps defects and interrupts where `Effect.result` / `option` discard them. Automation's `exitToJobOutcome` shows the full mapping discipline: success → processed, dies → retry with diagnostics, interrupts-only → retry, `TerminalJobError` → rejected, `AmbiguousJobError` → ambiguous, everything else → retry. Copy the nearest boundary instead of inventing a new order.

## Observability

Name spans at service-method granularity (`Effect.fn` or `Effect.withSpan`), attach `effectLoggerLayer` / `effectTracerLayer` at the scope, and keep secrets out of log annotations. Built-in runtime references live in `effect/References` (`CurrentLogAnnotations`, `CurrentLogLevel`, `CurrentTraceLevel`). The Effect logger (`packages/observability/src/effect-logger.ts`) pipes Effect events into structured logging with redaction and fiber annotations; the tracer (`effect-tracer.ts`) forwards sampled spans to OTLP and registers exports with `executionCtx.waitUntil` so telemetry never delays the response. Log failures through `failureDiagnostic` / `errorDiagnostic` projections, never raw provider payloads or tokens.

## Testing

Test through the Layer seam, one Layer per test. Provide `createXServiceTest` doubles, drive time with `TestClock.adjust` from `effect/testing` for retry/schedule tests, and fork-then-join (`Effect.forkChild` + `Fiber.join`) when the test must advance the clock mid-flight. Extract typed failures with `Effect.match(program, { onFailure, onSuccess })` rather than converting Causes into telemetry. Keep boundary mapping modules dependency-light (automation boundary is pg-free) so mapping tests pin outcomes without loading infrastructure.

## Anti-patterns

- Leaking requirements in service methods (`query: (...) => Effect<..., ..., Config | Logger>`). Fix: `R = never` methods, dependencies in Layer construction.
- Scattering `provide` / `provideService` through business logic. Fix: compose the full layer once, single `Effect.provide` at the boundary.
- Using `use()` everywhere instead of `yield*`. Fix: `gen` keeps dependencies visible.
- Yielding non-Effect types (`Option`, `Result`, `Ref`, `Deferred`) directly in `Effect.gen`. Fix: `Effect.fromOption`, `Effect.fromResult`, `Ref.get`.
- Catching defects as domain errors (`catch` expecting to catch `die` / throws). Fix: typed channel plus `catchTag`; `catchDefect` / `catchCause` only at boundaries.
- Assuming `catchTag` or `catch` runs when a defect is present. Fix: v4 mixed-cause precedence converts typed errors to defects; use `catchCause` if defect recovery is deliberate.
- Throwing in `sync` / `promise` constructors or omitting `catch` on `try` / `tryPromise`. Fix: explicit `catch` mapping to a domain error at every lift.
- Retrying writes or `rate_limit` inner retries. Fix: writes run once and reconcile; `429` propagates with its hint to the outer scheduler.
- Expecting `Effect.all` to run concurrently without options. Fix: pass `{ concurrency: "unbounded" }` or a concurrency limit.
- Duplicating parameterized Layers inline. Fix: store in a `const`; shared memoization is a safety net, not a composition strategy.
- Global mutable test state (suite-shared Layers, module-level maps). Fix: per-test `provide` of test Layers.
- Building request-scoped Layers once globally with `env`, or never disposing them. Fix: build per request / message / invocation from the current `env`, dispose after.

## v4 migrations that bite

v3 idioms that no longer compile or silently change meaning: `Context.Tag` / `GenericTag` / `Effect.Service` with auto `Default` (now `Context.Service` plus explicit `Layer.effect(this, this.make)`), static service accessors (now `yield*` or `Service.use`), `gen(function* (_) { yield* _(eff) })` (now `gen(function* () { yield* eff })`), `Option` / `Result` / `Ref` / `Deferred` no longer Effect subtypes (convert via `Effect.fromOption`, `Effect.fromResult`, `Ref.get`), `catchAll` / `catchSome` (now `catch` / `catchFilter` with `Filter`), `catchAllCause` / `catchAllDefect` (now `catchCause` / `catchDefect`), defects taking precedence in mixed causes (typed recovery skips causes with defects), `Cause` tree matching and `isFailure` / `failureOption` / `dieOption` (now flat `reasons` plus `hasDies` / `hasInterruptsOnly` / `findErrorOption` / `findDie`), `Either` (now `Result`, and `Effect.either` is now `Effect.result`), `FiberRef` (now `Context.Reference` and `References.*`), `Effect.locally` (now `Effect.provideService`), `fork` / `forkDaemon` (now `forkChild` / `forkDetach` with options), `Effect.Do` / `zipLeft` / `zipRight` (now `gen` / `tap` / `andThen`), `Runtime<R>` removed (now `Effect.context<R>()` + `runPromiseWith` / `runForkWith`), `Scope.extend` (now `Scope.provide`), nested `provide` reuses layers via ambient MemoMap (opt out with `{ local: true }` or `Layer.fresh`). When porting, consult upstream `MIGRATION.md`.

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
