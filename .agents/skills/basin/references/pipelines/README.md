# Basin Pipelines

Streaming ingest: receive events over HTTP/Workers/Logpush, transform with SQL, write to R2 as Iceberg tables or Parquet/JSON files.

This reference is a fast-start with verified code and gotchas. For limits, settings, full SQL syntax, and pricing, **retrieve the live docs** — they are the source of truth: [overview](https://developers.cloudflare.com/basin-pipelines/index.md) · [streams](https://developers.cloudflare.com/basin-pipelines/streams/index.md) · [sinks](https://developers.cloudflare.com/basin-pipelines/sinks/index.md) · [pipelines & SQL transforms](https://developers.cloudflare.com/basin-pipelines/pipelines/index.md) · [SQL reference](https://developers.cloudflare.com/basin-pipelines/sql-reference/index.md) · [wrangler commands](https://developers.cloudflare.com/basin-pipelines/reference/wrangler-commands/index.md) · [Terraform](https://developers.cloudflare.com/basin-pipelines/reference/terraform/index.md) · [limits](https://developers.cloudflare.com/basin-pipelines/platform/limits/index.md) · [pricing](https://developers.cloudflare.com/basin-pipelines/platform/pricing/index.md) · [metrics](https://developers.cloudflare.com/basin-pipelines/observability/metrics/index.md).

## Three components

| Component    | Purpose                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Stream**   | Receives events (HTTP endpoint, Worker binding, or Logpush); structured (schema-validated) or unstructured |
| **Pipeline** | SQL connecting a stream to a sink; row-level transforms only — no GROUP BY/aggregation                     |
| **Sink**     | Writes to R2 — Iceberg via Basin Catalog, or raw Parquet/JSON                                              |

Choose the **Iceberg/Basin Catalog sink** when you need SQL queries, ACID, or schema evolution; choose **raw Parquet/JSON files** for simple archival or external tools that read files directly.

```bash
npx wrangler basin pipelines setup   # interactive: stream + sink + pipeline (+bucket/catalog)
```

## Critical behaviors (read before building)

Non-obvious behaviors that cause most failures — detail in [gotchas.md](./gotchas.md):

- **Everything is immutable after creation** — stream schema, pipeline SQL, sink config. To change, delete and recreate.
- **Sinks create their own table** — they cannot target an existing Iceberg table.
- **`__ingest_ts` is added automatically** (TIMESTAMP, partitioned by day). Do not define it in your schema.
- **Data is not queryable immediately** — first flush takes 3–7 minutes (warm-up + table creation).
- **Schema validation is deferred** — invalid events are accepted, then silently dropped. Monitor GraphQL error metrics.
- **Binding field renamed `pipeline` → `stream`**; the old field is still accepted.

## In This Reference

- [configuration.md](./configuration.md) — schemas, streams, sinks, pipelines (CLI + REST + Terraform), bindings
- [api.md](./api.md) — `send()`, HTTP ingest, REST API, pipeline SQL, lifecycle states
- [patterns.md](./patterns.md) — fire-and-forget, validation, Logpush, observability, end-to-end
- [gotchas.md](./gotchas.md) — silent drops, immutability, REST≠CLI field names

## See Also

- [Basin Catalog](../catalog/README.md) — Iceberg sink destination
- [Basin SQL](../sql/README.md) — query the ingested data
- [R2](https://developers.cloudflare.com/r2/index.md) · [Queues](https://developers.cloudflare.com/queues/index.md) · [Workers](https://developers.cloudflare.com/workers/index.md)
