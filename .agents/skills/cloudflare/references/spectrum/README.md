# Cloudflare Spectrum

Use Spectrum to proxy non-HTTP TCP/UDP applications — SSH, games, MQTT, SMTP, databases, RDP, custom protocols — through Cloudflare's edge to hide the origin and absorb L4 DDoS. For HTTP/HTTPS traffic use the standard Cloudflare proxy instead.

Port and protocol coverage is plan-gated: Pro/Business get selected ports and protocols; only Enterprise gets arbitrary ports and port ranges. Check plan availability in the [Spectrum docs](https://developers.cloudflare.com/spectrum/index.md) before promising a configuration.

| Task                                                                    | Read                                   |
| ----------------------------------------------------------------------- | -------------------------------------- |
| Create or manage an app via REST or SDK                                 | [api.md](./api.md)                     |
| Pick an origin type (direct IP, CNAME, load balancer) or use Terraform  | [configuration.md](./configuration.md) |
| Protect a specific protocol (SSH, Minecraft, MQTT, SMTP, database, RDP) | [patterns.md](./patterns.md)           |
| Diagnose timeouts, firewall, or DNS problems                            | [gotchas.md](./gotchas.md)             |
