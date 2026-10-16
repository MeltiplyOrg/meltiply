# Cloudflare Workers Analytics Engine

Use Analytics Engine for high-cardinality, time-series analytics — millions of unique dimension values (user IDs, API keys) without degradation. Write data points from a Worker binding and query them through the SQL API. Typical uses: customer-facing dashboards, usage-based billing, and per-tenant monitoring.

For built-in product metrics, query the [GraphQL Analytics API](../graphql-api/README.md) instead; for raw logs and debugging, use [Workers Logs](../observability/README.md).

## Choose a task

| Task                                                | Start here                        |
| --------------------------------------------------- | --------------------------------- |
| Set up a binding, datasets, and limits              | [Configuration](configuration.md) |
| Write data points or query the SQL API              | [API](api.md)                     |
| Design use cases, field layout, and indexes         | [Patterns](patterns.md)           |
| Diagnose sampling, index selection, or missing data | [Gotchas](gotchas.md)             |

`writeDataPoint()` is fire-and-forget: it returns `void`, not a Promise, and writes asynchronously — do not `await` it or expect read-after-write visibility in the same request.

## See also

- [Analytics Engine docs](https://developers.cloudflare.com/analytics/analytics-engine/index.md)
- [GraphQL Analytics API](../graphql-api/README.md) — built-in Cloudflare product analytics
- [Observability](../observability/README.md) — Workers Logs, Traces, and real-time debugging
