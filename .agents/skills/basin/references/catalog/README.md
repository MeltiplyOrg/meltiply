# Basin Catalog

Use Basin Catalog for Apache Iceberg analytics and data pipelines on object storage. For transactional application queries, use a database; for unstructured objects, use [R2](https://developers.cloudflare.com/r2/index.md).

Two distinct APIs: the **Iceberg REST catalog** (used by query engines for table reads/writes) and the **Cloudflare control-plane API** (catalog administration). Pick the one matching your workflow.

Copy the actual **Catalog URI** and **Warehouse name** from the catalog detail page or Wrangler's enable output — do not reconstruct them from an assumed bucket naming convention. Retrieve [Manage catalogs](https://developers.cloudflare.com/basin-catalog/manage-catalogs/index.md) before setup or permission changes.

| Task                                                             | Read                                   |
| ---------------------------------------------------------------- | -------------------------------------- |
| Enable a catalog, discover connection values, choose credentials | [configuration.md](./configuration.md) |
| Select administration vs. engine APIs                            | [api.md](./api.md)                     |
| Choose a Python, Spark, or SQL workflow                          | [patterns.md](./patterns.md)           |
| Diagnose authentication, maintenance, or client problems         | [gotchas.md](./gotchas.md)             |

Related: [Basin Pipelines](../pipelines/README.md) for ingest, [Basin SQL](../sql/README.md) for querying.
