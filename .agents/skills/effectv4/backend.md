# Backend Effect patterns

Workers backend: `workers/api`, `workers/automation`, `workers/state`, plus `packages/database|secrets|storage|auth|providers|observability|domain`. Cloudflare Workers reuse isolates, so scope everything per request, message, or connection. Queue messages are at-least-once: consumers are idempotent, transient failures use exponential backoff, poison pills go to the DLQ.

## Boundaries

Each host owns exactly one runner; business logic never calls `Effect.run*`:

- API (`workers/api/src/effect/runtime.ts`): build the program with at most `R = RequestContext`, then `runWorkerEffect(c, program)` for JSON or `runRouteEffect(c, program)` for a shaped `Response`. The boundary builds a fresh `requestScope(c)` per request (`RequestContext`, logger, tracer), refuses pre-aborted signals, forwards the client `AbortSignal` to `runPromiseExit`, exports spans via `executionCtx.waitUntil`, and maps `Cause` dies-first into the OpenAPI envelope (5xx messages sanitized).
- Automation (`workers/automation/src/effect/boundary.ts`, `scope.ts`): build the job program, run it with `runJobProgram`, translate the `Exit` with `exitToJobOutcome` (`processed | skipped | enqueued` ack, `rejected` ack plus warn, `ambiguous` ack plus reconcile, `retry` with `min(3600, 15 * 2^attempts)` backoff). Keep boundary modules free of direct `pg` imports so unit tests stay light; `pg` enters behind dynamic `import()`. Outcome logging goes through `logJobOutcome` (`processed` → info, `rejected` → warn, else error; `retry` tags `queue_backoff`, `ambiguous` tags `reconciliation`).
- State (`workers/state/src/index.ts`): Durable Object methods compose with `Effect.gen`, run once through `runStateProgram` (`runPromiseExit` plus `Cause.squash`). Invalid input throws `TypeError` to honor the RPC contract; storage faults become `OAuthStateStorageError`. DO instances are single-threaded over SQLite, so get/delete pairs need no `transaction()` wrapper; expiry sweeps recompute the alarm to the earliest surviving `expires_at`.

Lift route steps with `fromPromise` (`workers/api/src/effect/route.ts`): typed `CoreApiError | DomainError | ProviderAdapterError` stay on the failure channel, unknown throws escape as defects.

## Per-request Layers

Compose `Layer.mergeAll(Layer.succeed(RequestContext, data), effectLoggerLayer(ctx), effectTracerLayer(ctx))` fresh per execution, as `requestScope` and `jobScope` do. Never capture `env` bindings (R2, Hyperdrive, D1) in a module-global Layer; derive live service Layers from the current `env` (`createStorageServiceLiveFromEnv`, `createDatabaseServiceLive(pool)`). Release local `pg` clients with destroy semantics (`destroyClientsOnRelease`) because workerd freezes module sockets. Automation scopes stay pg-free by construction: queue publisher, publish-queue resolver, and reply workflow dispatcher are binding-only, so scope construction needs only env metadata plus job correlation.

## Failure taxonomy

Provider failures (`packages/providers/src/failures.ts`) classify into seven classes; learn the table before writing retry or mapping logic:

| Class           | Meaning                                                 | Retryable        | Handling                                                   |
| --------------- | ------------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `ambiguous`     | Write timed out or malformed after possible side effect | No               | Reconcile via lookup, never blind-retry                    |
| `timeout`       | No outcome confirmed (timeout / 408)                    | Inner reads only | `withReadRetry`                                            |
| `transient`     | Malformed response or 5xx                               | Inner reads only | `withReadRetry`                                            |
| `rate_limit`    | 429 or parsed rate-limit reason                         | Outer only       | Propagate with `retryAfterSeconds`; worker scheduler parks |
| `auth`          | 401 / 403                                               | No               | Re-authenticate                                            |
| `quota`         | 402 / 507 or parsed quota reason                        | No               | Surface quota error                                        |
| `deterministic` | Provider rejected the request                           | No               | Fail typed                                                 |

Job failures (`workers/automation/src/effect/job-errors.ts`) mirror the same discipline: `RetryableJobError` redelivers with backoff, `TerminalJobError` acks poison (bad payload, producer-contract violation) and records diagnostics, `AmbiguousJobError` reconciles. `classifyJobError` preserves explicit typed outcomes and ambiguous provider classifications; every other throw stays retryable because an error's class or message cannot prove a delivery is invalid — payload guards must signal terminal explicitly. `unwrapJobError` rebuilds the original named Error so log grouping keeps the true `error_type` instead of the wrapper name.

## Error sanitization

The API boundary (`resolveFailure` in `workers/api/src/effect/runtime.ts`) maps one typed failure to status, code, and client-safe message:

- `CoreApiError` passes through with its explicit message and status.
- `DomainError` maps status via its code table and preserves its message.
- `ProviderAdapterError` with `rate_limit` surfaces 429 with provider message plus `Retry-After`; any other provider failure becomes sanitized 502 `"An unexpected error occurred."`.
- `Data.TaggedError` shapes sanitize every 5xx message while preserving client-actionable 4xx messages.
- Anything unshaped falls back to 500 `internal_error` with the generic message.

Practice: 4xx messages are caller-actionable and preserved; 5xx messages are operator-diagnostic and sanitized. Diagnostics still flow to logs via `errorDiagnostic`.

## Transactions

Wrap multi-statement writes in `withTransactionEffect` (`packages/database/src/index.ts`): acquire inside `tryPromise`, `BEGIN`, run the operation under `Effect.exit` (never let it throw across the boundary), `COMMIT` on success, uninterruptible `ROLLBACK` on failure, `failCause` to preserve the original cause, `ensuring` to release the client (destroy on rollback failure). Tenant writes use `withAuthenticatedTransactionEffect`, which sets `request.jwt.claims` plus a 10s `statement_timeout` as local session parameters; bad claims fail `InvalidRequestError` before any query runs. Never interpolate values into SQL; parameterize every query.

## Packages

- Secrets / storage / auth: thin `*Service` tags over promise clients. Encrypt/decrypt (`TokenCipher.encryptEffect/decryptEffect`), R2 head/delete/range/multipart, JWT/access-token verify each wrap one client call in `Effect.tryPromise` with domain-mapped `catch`. Storage keeps bucket and signer availability independent and fail-lazy so validation order is preserved; `getMetadataEffect` turns a missing object into `NotFoundError` via `flatMap` instead of a null check at the call site. Auth fails closed (`Effect.fail`) when verifiers are unconfigured, and loads Better Auth dynamically to avoid module-evaluation side effects in isolates.
- Providers (`packages/providers/src/effect.ts`): `providerCallEffect(ctx, call)` links fiber and caller abort (`AbortSignal.any`), copies metadata back, and normalizes unknown throws to `provider_unexpected`. Every write wrapper documents its exactly-once contract in its comment; only the three read wrappers (`listAnalytics`, `listComments`, `getRequirements`) are eligible for `withReadRetry`. Log failures only through `failureDiagnostic`.
- Observability: attach `effectLoggerLayer` / `effectTracerLayer` at the scope, annotate with `Effect.withSpan`, and keep secrets out of log annotations. The logger redacts and merges fiber `CurrentLogAnnotations`; the tracer respects the sampling decision and forwards exports to `waitUntil`.

## Tracing and cancellation

Name spans at service-method granularity (`Effect.fn` or `Effect.withSpan`), forward the caller `AbortSignal` into every `runPromiseExit`, and treat `Cause.hasInterruptsOnly` as cancellation (client-abort 499 vs server 503 in API), never as a domain failure. Sample logs per invocation (`configureJobLogging`) so high-volume queue workers stay within telemetry budget.
