# Cloudflare Argo Smart Routing

Use Argo Smart Routing to route proxied traffic across the fastest measured network path. Argo is being integrated into [Smart Shield](https://developers.cloudflare.com/smart-shield/index.md); existing zones keep full functionality during the transition.

Argo is usage-billed per GB of traffic and requires billing to be configured before it can be enabled — check zone eligibility and cost before enabling it on low-traffic or development zones.

## Choose a task

| Task                                               | Start here                        |
| -------------------------------------------------- | --------------------------------- |
| Enable or disable Argo via API or SDK              | [API](api.md)                     |
| Configure via Terraform, IaC, or billing           | [Configuration](configuration.md) |
| Combine with Tiered Cache or a Spectrum TCP app    | [Patterns](patterns.md)           |
| Diagnose enablement, permission, or billing errors | [Gotchas](gotchas.md)             |

## See also

- [Argo Smart Routing docs](https://developers.cloudflare.com/argo-smart-routing/index.md)
- [Smart Shield](https://developers.cloudflare.com/smart-shield/index.md)
- [Spectrum](../spectrum/README.md) — proxied TCP/UDP applications
- [Tiered Cache](https://developers.cloudflare.com/cache/how-to/tiered-cache/index.md)
