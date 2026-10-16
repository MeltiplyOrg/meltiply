# Cloudflare Flagship

Use Flagship for feature flags: toggles, targeting rules, and percentage rollouts evaluated without redeploying. Flags are organized into apps; a flag returns one of its typed variations (boolean, string, number, or JSON) based on sequential targeting rules matched against the evaluation context — first match wins, otherwise the default. Percentage rollouts bucket consistently on a chosen attribute.

Two evaluation paths: the `env.FLAGS` binding inside Workers (lowest latency, no HTTP) or the OpenFeature SDK (`@cloudflare/flagship`) for other runtimes or vendor neutrality. REST management endpoints use the v4 envelope with snake_case fields; the `/evaluate` endpoint is the exception — un-enveloped and camelCase.

## Choose a task

| Task                                                      | Start here                        |
| --------------------------------------------------------- | --------------------------------- |
| Add the binding, install the SDK, or set up types         | [Configuration](configuration.md) |
| Evaluate flags or call binding/REST endpoints             | [API](api.md)                     |
| Design targeting rules, rollouts, or flag CRUD            | [Patterns](patterns.md)           |
| Diagnose wrong evaluations, type mismatches, or conflicts | [Gotchas](gotchas.md)             |

## See also

- [Flagship API reference](https://developers.cloudflare.com/api/resources/flagship/index.md) — source of truth for REST paths, envelopes, and fields
- [Workers docs](https://developers.cloudflare.com/workers/index.md) — the runtime Flagship binds into
- [Wrangler docs](https://developers.cloudflare.com/workers/wrangler/index.md) — deployment and configuration
