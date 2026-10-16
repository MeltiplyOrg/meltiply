# Cloudflare Terraform Provider

Use the [Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs) for infrastructure as code across Cloudflare resources.

**Hard rules:**

- Manage a resource through one system only — never split the same resource between Terraform and wrangler.jsonc or dashboard edits.
- Pin the provider version (`~>`), use remote state for shared environments, and keep API tokens in variables or environment variables — never hardcoded.
- Provider v5 renamed many resources (`cloudflare_record` → `cloudflare_dns_record`, `cloudflare_worker_*` → `cloudflare_workers_*`) and carries breaking changes from v4; see [gotchas.md](./gotchas.md) before upgrading or writing new resources from old examples.
- Prefer scoped API tokens over the Global API Key; user service keys only where required (Origin CA).

To adopt existing infrastructure, generate and import configuration with [cf-terraforming](https://github.com/cloudflare/cf-terraforming) rather than writing resources by hand.

## In This Reference

- [configuration.md](./configuration.md) — resource configurations for zones, DNS, Workers, KV, R2, D1, Pages, rulesets
- [api.md](./api.md) — data sources for querying existing resources
- [patterns.md](./patterns.md) — module layout, multi-environment setup, CI/CD integration
- [gotchas.md](./gotchas.md) — state drift, v5 breaking changes, security pitfalls

## See Also

- [Pulumi](../pulumi/README.md) — alternative IaC tool for Cloudflare
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/index.md) — CLI deployment alternative
