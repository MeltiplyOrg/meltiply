# Cloudflare Tunnel

Use Tunnel to connect origin services to Cloudflare without a publicly routable IP. Inspect the existing tunnel, its management mode (remotely managed vs. locally managed config file), and the intended audience before choosing a setup. Fetch current docs for commands, configuration, and limits.

Decide whether the goal is a public application, authenticated private access, or connectivity from a Worker, and who owns the configuration. Multiple environments alone do not require local management.

| Task                                                          | Documentation                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Create a remotely-managed or temporary development tunnel     | [Setup](https://developers.cloudflare.com/tunnel/get-started/index.md)                                                                    |
| Maintain a tunnel managed through local files                 | [Create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/index.md) |
| Publish an application and check protocol requirements        | [Routing](https://developers.cloudflare.com/tunnel/concepts/routing/index.md)                                                             |
| Choose private networking, Workers VPC, or Access integration | [Integrations](https://developers.cloudflare.com/tunnel/integrations/index.md)                                                            |

## In This Reference

- [configuration.md](./configuration.md) — management mode, ingress, and origin settings
- [networking.md](./networking.md) — firewall, connectivity, and private-network investigation
- [api.md](./api.md) — programmatic setup and tunnel operations
- [patterns.md](./patterns.md) — deployment and availability decisions
- [gotchas.md](./gotchas.md) — troubleshooting and operational checks
