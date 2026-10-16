# Frontend Effect patterns

React SPA: `frontend/app/src/lib/effect/*` plus `lib/api.ts`, `lib/upload.ts`, `lib/queries.ts`, and query/mutation hooks. UI changes still follow `frontend/app/AGENTS.md` design-system guardrails.

## Boundaries

Two runners, one path. `runQueryEffect` (`lib/effect/runtime.ts`) is the only `Effect.run*` site: it rejects pre-aborted signals, runs `Effect.scoped(effect)` with the caller signal, then unwraps dies-first (defect → interrupt → typed error). `runFrontendEffect` (`lib/effect/services.ts`) provides `frontendStaticServicesLive` plus the per-invocation `WorkspaceService` and delegates to `runQueryEffect`. Hooks call `runFrontendEffect(scope, program, { signal })` and let React Query own caching, retries, and cancellation. Gate execution on `scope.isSignedIn` before running; the scope carries no credential (the Better Auth session cookie is ambient, the `/api/v1` bearer JWT is stamped by the fetch wrapper).

## Lifting client calls

One convention lifts every generated OpenAPI operation (`lib/api.ts`): keep the request lazy inside the thunk so retries and interruption behave, take the fiber-bound `AbortSignal` from `Effect.promise` (a caller signal such as an upload task's own controller takes precedence), fail non-2xx responses with a typed `ApiError`, and let transport rejections (network failures, aborts) surface as defects so they are never misclassified as typed API errors.

`ApiError` carries everything the UI and telemetry need:

| Field                                  | Source                                             |
| -------------------------------------- | -------------------------------------------------- |
| `status`, `code`, `details`, `message` | ErrorEnvelope payload, or `unknown_error` fallback |
| `requestId`                            | Envelope `request_id`, or `x-request-id` header    |
| `retryAfterSeconds`                    | `Retry-After` header (seconds or HTTP date)        |
| `retryable`                            | Envelope flag, or `status >= 500`                  |

Construction reports to frontend telemetry (`reportFrontendApiError` plus `reportFrontendError`), so throwing the error is also the reporting path — do not double-report at call sites.

## Services

Static services (`ApiClientService`, `PublicConfigService`, `FeatureAvailabilityService`, `FrontendTelemetryService`) merge once in `frontendStaticServicesLive` because they hold no user or workspace state. Request state travels explicitly: `ApiClientService` operations require `WorkspaceService` (`ApiClientEffect<T> = Effect<A, ApiError, WorkspaceService>` via `inWorkspace`), and `runFrontendEffect` provides the workspace per call. Never stash workspace, session, or query data in a module global; pass it through the Layer at the call site. `WorkspaceService` itself is plain data (`workspaceId: string | null`), provided with `Effect.provideService` — `null` selects the personal workspace and is sent as a missing `x-workspace-id` header, never as a failure.

Follow the `api-client.ts` shape for new client operations: resolve `WorkspaceService`, delegate to the matching `lib/api.ts` adapter (typed `ApiError` failures, interruption-bound abort), and extend `createApiClientServiceTest` so unstubbed operations die loudly.

## Queries and mutations

Compose query programs from service methods with `gen` / `flatMap`; keep `lib/api.ts` adapters as the single lift from the generated OpenAPI client into `Effect`. Three helpers keep hooks consistent (`lib/queries.ts`): `normalizeParams` strips `undefined` and sorts keys so cache keys match structurally identical requests; `withBrandProfile` merges `scope.brandProfileId` into params (`null` omits the key for the workspace-wide view, an explicit param wins); `pollingInterval` (`lib/query-defaults.ts`) centralizes refetch cadence. State-mutating requests carry idempotency keys: `mutationKey` defaults to `createMutationKey` (UUID v4 via `crypto.randomUUID` with a CSPRNG fallback), and `useMutationKeyTracker` gives each mutation hook a stable tracker whose `keyFor(input)` reuses the key for identical normalized payloads and issues a fresh one when the payload changes — retries then replay safely instead of duplicating.

## Uploads

Uploads orchestrate the session state machine (`creating → uploading → completing → processing → complete`, with `paused | offline | cancelled | failed`) over the `UploadApi` seam (`lib/upload.ts`). The seam's error channel is deliberately `unknown`: the orchestrator treats every failure generically (retry/stop propagation), which also lets test fakes fail with plain errors instead of constructing `ApiError`s. Wrap XHR in `Effect.callback` with abort cleanup, back off with `Effect.sleep`, parallelize multipart parts with forked fibers joined by `Fiber.awaitAll` rather than raw `Promise.all`, and persist resumable sessions (`ResumableUpload`) so a dropped connection resumes instead of restarting. First argument of every seam member is the explicit workspace selection; credentials never pass through it.

## Testing

Provide test Layers per test (`createApiClientServiceTest` with stubbed operations); avoid shared suite Layers that leak state between tests. Assert on the unwrapped outcome (resolved value or thrown `ApiError`), matching `lib/effect/runtime.test.ts`. For upload orchestration, fake the `UploadApi` seam with plain values and plain throws — the `unknown` channel exists precisely so fakes stay simple.
