# Cloudflare AI Search

Use AI Search for managed content indexing and retrieval, with optional answer generation. For custom embeddings and vector-index management use [Vectorize](../vectorize/README.md); for model inference without a managed retrieval pipeline use [Workers AI](../workers-ai/README.md). Start with [How AI Search works](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/index.md).

Read the linked page before implementing; these references route to maintained documentation instead of copying API examples or configuration. For freshness requirements, read [Syncing](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/index.md) for your data source before choosing an architecture, and check current [limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/index.md) rather than assuming a fixed indexing interval or account limit.

## Choose a task

| Task                                                       | Start here                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Build a new Worker integration                             | [Workers binding quick start](https://developers.cloudflare.com/ai-search/get-started/workers/index.md) |
| Choose an API or maintain an existing integration          | [API routes](api.md)                                                                                    |
| Connect data, configure indexing, or manage environments   | [Configuration routes](configuration.md)                                                                |
| Choose retrieval, generation, or tenant isolation patterns | [Pattern routes](patterns.md)                                                                           |
| Diagnose indexing, authentication, filters, or limits      | [Troubleshooting routes](gotchas.md)                                                                    |

Existing `env.AI.autorag()` integrations continue to work. Use the [migration guide](https://developers.cloudflare.com/ai-search/api/migration/workers-binding/index.md) when upgrading; migration is not required just to maintain an existing integration.
