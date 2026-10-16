# Cloudflare Workers Smart Placement

Use Smart Placement to run a Worker closer to the backends it calls instead of close to the end user. Fetch the [Smart Placement docs](https://developers.cloudflare.com/workers/configuration/smart-placement/index.md) before enabling it; check status and rollout rules there.

**Enable when** the Worker makes repeated backend calls (DB/API round trips) against geographically concentrated infrastructure. **Skip it** when the Worker serves cached or static content, does pure edge logic, lacks a `fetch` handler, or is an assets Worker with `run_worker_first` — placement can degrade asset serving. Smart Placement analyzes the `fetch` handler only; RPC methods and named entrypoints are not placed.

The preferred architecture is a split: an edge frontend Worker bound by service binding to a backend Worker that has Smart Placement enabled — see [patterns.md](./patterns.md).

| Task                                                        | Read                                   |
| ----------------------------------------------------------- | -------------------------------------- |
| Configure `placement` in wrangler.jsonc and check limits    | [configuration.md](./configuration.md) |
| Check placement status and the `cf-placement` header        | [api.md](./api.md)                     |
| Split frontend/backend or optimize a database-backed Worker | [patterns.md](./patterns.md)           |
| Diagnose `INSUFFICIENT_INVOCATIONS` or a reverted placement | [gotchas.md](./gotchas.md)             |

Expect up to ~15 minutes of analysis after enabling, and check `placement_status` before drawing conclusions: `SUCCESS` means placed, `INSUFFICIENT_INVOCATIONS` means more traffic is needed, `UNSUPPORTED_APPLICATION` means placement hurt and was reverted.

## See Also

- [D1](../d1/README.md) — backend database that benefits from Smart Placement
- [Bindings](../bindings/README.md) — service bindings for the frontend/backend split
