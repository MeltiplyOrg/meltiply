# Basin SQL

Serverless, distributed, **read-only** query engine (Apache DataFusion) for Apache Iceberg tables in Basin Catalog.

For the authoritative function list, data types, limitations, and pricing, **retrieve the live docs**: [get started](https://developers.cloudflare.com/basin-sql/get-started/index.md) · [query data](https://developers.cloudflare.com/basin-sql/query-data/index.md) · [SQL reference](https://developers.cloudflare.com/basin-sql/sql-reference/index.md) · [limitations & best practices](https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/index.md) · [wrangler commands](https://developers.cloudflare.com/basin-sql/reference/wrangler-commands/index.md) · [pricing](https://developers.cloudflare.com/basin-sql/platform/pricing/index.md).

## Connection values

| Value         | Format                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| REST endpoint | `https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/basin-sql/query/{BUCKET}` |
| Wrangler      | `npx wrangler basin sql query "{WAREHOUSE}" "<SQL>"` with `WRANGLER_BASIN_SQL_AUTH_TOKEN` set |
| Warehouse     | `{ACCOUNT_ID}_{BUCKET}`                                                                       |

The REST host is `api.sql.cloudflarestorage.com` — **not** the account API host — and the query path is `/basin-sql/query/`; a legacy `/r2-sql/query/` path may still work but should not be used for new integrations.

**Use for:** SQL analytics over Iceberg (logs, BI, ad-hoc), dashboards via a Worker `fetch()` to the REST endpoint. **Not for:** writes (use PySpark/PyIceberg) or real-time OLTP (<100 ms). There is **no Workers binding** — call the REST endpoint with the token stored as a secret; see [patterns.md](./patterns.md).

## In This Reference

- [configuration.md](./configuration.md) — catalog enablement, tokens, environment setup
- [api.md](./api.md) — SQL templates, JOIN/window examples, response format, data types
- [patterns.md](./patterns.md) — CLI/REST/Worker queries, pagination, performance
- [gotchas.md](./gotchas.md) — what works vs. not, performance, troubleshooting

## See Also

- [Basin Catalog](../catalog/README.md) — PyIceberg/PySpark, table management
- [Basin Pipelines](../pipelines/README.md) — streaming ingest into queryable tables
