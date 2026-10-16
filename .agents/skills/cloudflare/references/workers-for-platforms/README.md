# Cloudflare Workers for Platforms

Use Workers for Platforms to run customer-supplied or AI-generated code in isolated Workers under your account — multi-tenant SaaS, programmable platforms, website builders, unlimited per-customer deployment. For running only your own code, use regular Workers; for general untrusted-code sandboxing, also evaluate the [Sandbox](https://developers.cloudflare.com/sandbox/index.md).

**Architecture:** customer code lives in a **dispatch namespace** (unlimited scripts, per-customer limits); a **dispatch Worker** receives every request, applies platform logic (auth, limits, validation), and calls `env.DISPATCHER.get(name)` to invoke the target **user Worker**; an optional **outbound Worker** intercepts user Workers' external fetches for egress control and logging. User Workers run untrusted by default — no `request.cf`, no shared cache — so only opt into trusted mode when the code needs `request.cf` data or is fully controlled.

The [Platform Starter Kit](https://github.com/cloudflare/workers-for-platforms-example) deploys a complete working setup; start there rather than assembling the pieces from scratch.

## In This Reference

- [configuration.md](./configuration.md) — namespace creation, dispatch binding, limits
- [api.md](./api.md) — deploying user Workers, dispatch and outbound-worker APIs
- [patterns.md](./patterns.md) — routing strategies, isolation modes, billing, egress
- [gotchas.md](./gotchas.md) — limits, isolation issues, production pitfalls

## See Also

- [Workers](https://developers.cloudflare.com/workers/index.md) — core runtime documentation
- [Durable Objects](https://developers.cloudflare.com/durable-objects/index.md) — stateful multi-tenant patterns
- [Reference Architecture: Programmable Platforms](https://developers.cloudflare.com/reference-architecture/diagrams/serverless/programmable-platforms/index.md)
