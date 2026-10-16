---
name: effectv4
description: Develop with Effect v4 (Effect.gen programs, Context.Service services, Layers, typed errors, Cause/Exit boundaries). Use when writing or editing Effect programs, services, layers, retries, or error mapping in Workers backend (workers/api, automation, state, packages/*) or frontend (frontend/app/src/lib/effect, queries, uploads), or migrating v3 idioms to v4.
---

# Effect v4

Build every Effect change as a composable program that ends at one approved boundary.

## Tight loop

1. **Name the branch.** Backend worker/package, frontend query/mutation, or shared domain error. Open only that branch file.
2. **Apply [core](core.md).** Type, `gen`, Service, Layer, error-channel, and Cause rules hold on every branch.
3. **Apply one branch.** Backend: [backend](backend.md). Frontend: [frontend](frontend.md).
4. **Close at the boundary.** No `Effect.run*` outside the approved runner for the branch. No new runner.

## Branch map

- Touching `workers/api`, `workers/automation`, `workers/state`, or `packages/database|secrets|storage|auth|providers|observability|domain` → [backend](backend.md).
- Touching `frontend/app/src/lib/effect`, `lib/queries.ts`, `lib/api.ts`, `lib/upload.ts`, or a query/mutation hook → [frontend](frontend.md).
- Adding or changing a domain failure → define it in `packages/domain/src/effect/errors.ts` first, then follow the branch file.

## Completion bar

Every modified program satisfies all of these:

- Service methods carry `R = never`; dependencies enter through Layer construction.
- Every async boundary uses `Effect.tryPromise` with an explicit `catch` to a domain error; every sync boundary uses `Effect.try` the same way.
- Defects (`throw`, `die`) reach only the branch boundary, which checks `Cause.hasDies` first.
- Each touched Service ships a live Layer and a test Layer; each touched program has a test through its Layer.
- Retries cover reads only and carry a bounded schedule plus a failure predicate; writes run once and reconcile.
- Mutations carry idempotency keys; spans name the service method; secrets stay out of logs.
- `bun run docs:check` passes for skill-only changes; the repo gate in `AGENTS.md` passes for code changes.
