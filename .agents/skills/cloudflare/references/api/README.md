# Cloudflare REST API

Use the REST API to manage Cloudflare resources programmatically. Inside Workers, prefer the product's [binding](../bindings/README.md) for supported operations; use the REST API when the caller or operation requires it. For infrastructure-as-code, see [Terraform](../terraform/README.md) or [Pulumi](../pulumi/README.md).

Authenticate with scoped **API tokens** for all new projects — the global API key grants full account access and is a legacy path. The official `cloudflare` SDKs (TypeScript, Python, Go) are Stainless-generated from the OpenAPI spec; rate limits and retry behavior are covered under [Gotchas](gotchas.md).

## Choose a task

| Task                                                 | Start here                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize an SDK client, paginate, or handle errors | [API](api.md)                                                                                                                             |
| Set credentials, timeouts, retries, or Wrangler auth | [Configuration](configuration.md)                                                                                                         |
| Implement batch operations or common workflows       | [Patterns](patterns.md)                                                                                                                   |
| Diagnose errors, rate limits, or SDK-specific issues | [Gotchas](gotchas.md)                                                                                                                     |
| Call a product-specific API                          | The product's reference (e.g. [R2](../r2/README.md), [KV](../kv/README.md)) or [API docs](https://developers.cloudflare.com/api/index.md) |

## See also

- [Cloudflare API docs](https://developers.cloudflare.com/api/index.md)
- [Bindings](../bindings/README.md) — Workers runtime bindings, preferred over REST inside Workers
- [Wrangler docs](https://developers.cloudflare.com/workers/wrangler/index.md) — CLI for Cloudflare development
- [GraphQL Analytics API](../graphql-api/README.md) — analytics data via a separate GraphQL endpoint
