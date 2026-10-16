# Cloudflare Snippets

Use Snippets for small HTTP request/response modifications executed by the Ruleset Engine at the edge — header changes, rewrites, A/B assignment, geo routing. For anything needing Workers APIs (KV, D1, R2, Durable Objects, cron), npm packages, or real compute, use a Worker: Snippets are for modifications, Workers are for applications.

**Hard constraints** (paid plans only): 5 ms CPU per request, 32 KB per snippet, a small per-plan fetch subrequest budget, and a Workers-API subset. Snippets run synchronously in the request path, so keep them tight. Confirm current limits in the [Snippets docs](https://developers.cloudflare.com/rules/snippets/index.md).

| Task                                                            | Read                                   |
| --------------------------------------------------------------- | -------------------------------------- |
| Create a snippet and deploy via dashboard, API, or Terraform    | [configuration.md](./configuration.md) |
| Use the request/response, headers, and `request.cf` API surface | [api.md](./api.md)                     |
| Find a working example (headers, A/B, geo, redirects)           | [patterns.md](./patterns.md)           |
| Debug execution errors, limits, or rule matching                | [gotchas.md](./gotchas.md)             |
