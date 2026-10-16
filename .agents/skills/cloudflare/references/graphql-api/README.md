# Cloudflare GraphQL Analytics API

Use the GraphQL Analytics API to query built-in metrics across Cloudflare products — HTTP requests, Workers, DNS, Firewall, storage, AI — through a single read-only endpoint: `POST https://api.cloudflare.com/client/v4/graphql`. Build queries interactively in the [GraphQL Explorer](https://graphql.cloudflare.com/) before writing code.

Key facts that shape every query:

- Queries are rooted at `viewer { zones(filter: {zoneTag}) { ... } }` or `viewer { accounts(filter: {accountTag}) { ... } }`; each dataset node takes a `filter`, a required `limit`, and `orderBy`.
- The API is read-only — the Mutation type is a stub.
- Rate limiting is cost-based (roughly 300 queries per 5 minutes per user); complex queries cost more. Check [gotchas](gotchas.md) for current limits and sampling caveats.
- Datasets named `*Adaptive*` are sampled — results are statistically representative, not exact; `*1hGroups`/`*1dGroups`/`*1mGroups` are pre-aggregated rollups.
- For custom high-cardinality metrics use [Analytics Engine](../analytics-engine/README.md); for raw logs use Logpush, not this API.

## Choose a task

| Task                                                       | Start here                        |
| ---------------------------------------------------------- | --------------------------------- |
| Authenticate and set up a client                           | [Configuration](configuration.md) |
| Build a query: datasets, dimensions, aggregations, filters | [API](api.md)                     |
| Implement time-series, top-N, or per-product dashboards    | [Patterns](patterns.md)           |
| Diagnose rate limits, sampling, or query errors            | [Gotchas](gotchas.md)             |

## See also

- [GraphQL Analytics API docs](https://developers.cloudflare.com/analytics/graphql-api/index.md)
- [Analytics Engine](../analytics-engine/README.md) — custom high-cardinality analytics from Workers
- [Observability](../observability/README.md) — Workers Logs, Tail Workers, debugging
- [Web Analytics](../web-analytics/README.md) — client-side (RUM) analytics
- [REST API](../api/README.md) — REST endpoints and SDK authentication
