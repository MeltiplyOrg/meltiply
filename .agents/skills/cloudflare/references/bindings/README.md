# Cloudflare Workers Bindings

Bindings grant a Worker access to configured resources through its environment. Prefer a product's binding for supported operations inside Workers; use the [REST API](../api/README.md) only when the caller or operation requires it.

Read the relevant current documentation before implementing. These references route to maintained APIs and configuration rather than copying binding catalogs, type tables, or limits.

## Choose a task

| Task                                                    | Reference                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Survey the capability model and available products      | [Bindings overview](https://developers.cloudflare.com/workers/runtime-apis/bindings/index.md)  |
| Choose a storage product                                | [Storage options](https://developers.cloudflare.com/workers/platform/storage-options/index.md) |
| Access bindings in code or generate types               | [API](api.md)                                                                                  |
| Configure bindings, environments, secrets, or local dev | [Configuration](configuration.md)                                                              |
| Call Worker-to-Worker or test bound resources           | [Patterns](patterns.md)                                                                        |
| Diagnose missing bindings, stale clients, or limits     | [Gotchas](gotchas.md)                                                                          |

Treat each binding as a capability granted to code: select only the resources the Worker needs, and confirm which environment and resource each binding targets before using it.
