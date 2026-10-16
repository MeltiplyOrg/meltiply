# Cloudflare Durable Objects Storage

Use SQLite storage for new classes. Existing KV-backed classes need their matching API reference; calling key-value methods does not by itself identify the backend. Fetch the relevant current documentation before implementing or reviewing changes.

## Choose a task

| Task                                                 | Documentation                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose SQL, key-value, transaction, or recovery APIs | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/index.md); [legacy KV storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/index.md) |
| Configure the backend, class lifecycle, or placement | [Configuration](configuration.md)                                                                                                                                                                                      |
| Find operation semantics and storage options         | [API](api.md)                                                                                                                                                                                                          |
| Design schemas, caches, scheduled work, or cleanup   | [Patterns](patterns.md)                                                                                                                                                                                                |
| Diagnose concurrency, limits, or billing             | [Gotchas](gotchas.md)                                                                                                                                                                                                  |
| Verify storage behavior in the Workers runtime       | [Testing](testing.md)                                                                                                                                                                                                  |

For object routing, WebSockets, and coordination design, see the [Durable Objects skill](../../../durable-objects/SKILL.md).
