# Cloudflare D1

Use D1 for managed relational application data with SQLite semantics. For an existing external database use [Hyperdrive](../hyperdrive/README.md); for per-entity coordination use [Durable Objects](https://developers.cloudflare.com/workers/platform/storage-options/index.md#sql-in-durable-objects-vs-d1). See [storage options](https://developers.cloudflare.com/workers/platform/storage-options/index.md) before choosing a product.

Read the relevant current documentation before implementing. These references route tasks to the source of truth rather than maintaining copies of APIs, configuration, or plan tables.

## Choose a task

| Task                                                   | Start here                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a database, bind it, and run a first query      | [Get started](https://developers.cloudflare.com/d1/get-started/index.md)                                                                              |
| Configure bindings, migrations, local dev, or an ORM   | [Configuration](configuration.md)                                                                                                                     |
| Write parameterized queries, batches, or sessions      | [API](api.md)                                                                                                                                         |
| Design queries, caching, tenant isolation, or recovery | [Patterns](patterns.md)                                                                                                                               |
| Diagnose errors, types, constraints, or performance    | [Gotchas](gotchas.md)                                                                                                                                 |
| Check capacity, allowances, or plan availability       | [Limits](https://developers.cloudflare.com/d1/platform/limits/index.md) and [pricing](https://developers.cloudflare.com/d1/platform/pricing/index.md) |
