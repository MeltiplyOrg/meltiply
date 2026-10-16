# Cloudflare Workflows

Use Workflows for durable, multi-step jobs that must retry, wait, and resume without losing completed work. An instance is one execution; steps define persistence and retry boundaries.

Fetch the relevant current documentation before implementing — API shapes, configuration, testing helpers, limits, and examples live there, not in this reference:

- **Start a project:** [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/index.md) — scaffolding, configuration, deployment, a first instance.
- **Design durable execution:** [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/index.md) — step boundaries, replay, state, idempotency.
- **Implement or manage an instance:** [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/index.md) — steps, instance operations, parameters, return types.
- **Check capacity and cost:** [limits](https://developers.cloudflare.com/workflows/reference/limits/index.md) and [pricing](https://developers.cloudflare.com/workflows/reference/pricing/index.md) for the target plan.

## In This Reference

- [configuration.md](./configuration.md) — setup, bindings, retry configuration, local development
- [api.md](./api.md) — steps, instance lifecycle, events, CLI and REST operations
- [patterns.md](./patterns.md) — design decisions, orchestration, tests
- [gotchas.md](./gotchas.md) — failures, timeouts, replay, capacity investigation

## See Also

- [Durable Objects](https://developers.cloudflare.com/durable-objects/index.md) — stateful coordination
- [Queues](../queues/README.md) — asynchronous message delivery
- [Workers](https://developers.cloudflare.com/workers/index.md) — application entry points that trigger instances
