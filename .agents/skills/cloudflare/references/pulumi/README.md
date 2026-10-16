# Cloudflare Pulumi Provider

Use this reference to manage Cloudflare resources — Workers, Pages, D1, KV, R2, DNS, Queues — with the Pulumi provider (`@pulumi/cloudflare`, v6.x). Fetch the [Pulumi registry docs](https://www.pulumi.com/registry/packages/cloudflare/) for current resource schemas before writing code; resource shapes change between provider versions.

## Constraints to keep

- Use API tokens, not legacy API keys: set `CLOUDFLARE_API_TOKEN` or pass `apiToken` to an explicit `cloudflare.Provider`.
- Keep `accountId` in stack config (`pulumi config set cloudflare:accountId`); most resources require it, and `zoneId` is required for DNS and domain resources.
- Match binding names between the Worker script and the Pulumi resource — a mismatched `name` in `*Bindings` breaks the deployment silently at runtime.
- Set `module: true` on `WorkerScript` for ES modules, and pin `compatibilityDate` to lock runtime behavior.

## Read for the task

| Task                                                          | Reference                              |
| ------------------------------------------------------------- | -------------------------------------- |
| Provider setup, WorkerScript and binding resource shapes      | [configuration.md](./configuration.md) |
| Outputs, dependencies, imports, dynamic providers             | [api.md](./api.md)                     |
| Multi-environment stacks, secrets, CI/CD, component resources | [patterns.md](./patterns.md)           |
| State issues, deployment failures, limits                     | [gotchas.md](./gotchas.md)             |

## See also

- [terraform](../terraform/) — alternative IaC for Cloudflare.
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/index.md) — CLI deployment alternative.
- [Workers](https://developers.cloudflare.com/workers/index.md) — runtime documentation.
