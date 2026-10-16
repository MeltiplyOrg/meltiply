# Workers VPC Connectivity (TCP Sockets)

Use the TCP Sockets API (`cloudflare:sockets`) to open outbound TCP connections from a Worker to private services — custom wire protocols (Postgres wire, Redis RESP, SSH, MQTT, SMTP), StartTLS, or streaming binary — typically reaching private networks through Cloudflare Tunnel.

**Choose the technology first:**

| Requirement                              | Use                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| HTTP/HTTPS APIs in a private network     | `fetch()`, or VPC Services (beta) for SSRF-safe declarative bindings     |
| PostgreSQL/MySQL                         | [Hyperdrive](../hyperdrive/README.md) — pooling and caching beat raw TCP |
| Custom TCP protocols                     | TCP Sockets (this reference)                                             |
| WebSocket                                | Native Workers WebSocket API                                             |
| Expose on-prem to the internet (inbound) | [Cloudflare Tunnel](../tunnel/README.md)                                 |

**Constraints:** max 6 concurrent sockets per request; Cloudflare IPs, localhost, and port 25 are blocked; sockets must be created inside a handler (not global scope) and always closed. Allowlist destinations — raw TCP is an SSRF vector. See [gotchas.md](./gotchas.md) for the full list.

**Architecture:** Worker → `connect()` → Tunnel hostname → `cloudflared` → private service. Pair with [Smart Placement](../smart-placement/README.md) when latency to the private network matters. See [configuration.md](./configuration.md) for Tunnel setup.

## In This Reference

- [api.md](./api.md) — `connect()`, socket interface, types, TLS options
- [configuration.md](./configuration.md) — wrangler setup and Tunnel integration
- [patterns.md](./patterns.md) — databases, protocols, and error handling
- [gotchas.md](./gotchas.md) — limits, blocked ports, common errors

## See Also

- [TCP Sockets API docs](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/index.md)
- [Connect to databases tutorial](https://developers.cloudflare.com/workers/tutorials/postgres/index.md)
