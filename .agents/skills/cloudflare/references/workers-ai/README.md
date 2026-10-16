# Cloudflare Workers AI

Use Workers AI for managed model inference from Workers or an external service. Fetch the relevant documentation before choosing a model or writing integration code; model availability, schemas, capabilities, limits, and prices change independently.

## Choose a model

Start with the [model catalog](https://developers.cloudflare.com/workers-ai/models/index.md) and open the selected model's page for its exact identifier, input/output schema, context window, and supported features. Compare candidates on the user's task, language, quality requirements, latency, and [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/index.md). Evaluate with representative inputs rather than treating model size as a quality or cost ranking.

For tool use, streaming, or structured output, confirm support for the selected model and integration. For embeddings, check output dimensions and compatibility with the existing index; changing the model may require re-embedding stored documents, even if dimensions match.

## Task routing

| Task                                                                       | Read                                   |
| -------------------------------------------------------------------------- | -------------------------------------- |
| Configure bindings, types, or a development setup                          | [configuration.md](./configuration.md) |
| Write inference calls: schemas, streaming, tool calling, structured output | [api.md](./api.md)                     |
| Choose direct generation vs. RAG; find integration examples                | [patterns.md](./patterns.md)           |
| Diagnose binding, schema, limit, pricing, or SDK issues                    | [gotchas.md](./gotchas.md)             |

If a topic is missing, use the [Workers AI documentation index](https://developers.cloudflare.com/workers-ai/llms.txt) to find its current page.

## Related products

- [Vectorize](../vectorize/README.md) — vector storage and retrieval
- [AI Gateway](../ai-gateway/README.md) — inference analytics, caching, and request controls
- [Workers](https://developers.cloudflare.com/workers/index.md) — runtime and application hosting
