# Cloudflare TURN Service

Use Cloudflare TURN (Traversal Using Relays around NAT) when WebRTC clients cannot establish direct peer-to-peer paths — symmetric NATs, corporate firewalls, or carrier-grade NAT — and need a managed relay on Cloudflare's anycast network. No region or server selection is required; STUN and TURN run over UDP, TCP, and TLS.

TURN is free when used with Cloudflare Calls SFU; standalone usage is billed per GB of outbound relay traffic. Verify current pricing in the [TURN docs](https://developers.cloudflare.com/realtime/turn/index.md).

| Task                                                           | Read                                   |
| -------------------------------------------------------------- | -------------------------------------- |
| Create a TURN key and generate temporary credentials           | [api.md](./api.md)                     |
| Configure a Worker for credential issuance and IP allowlisting | [configuration.md](./configuration.md) |
| Wire TURN into a WebRTC client or SFU                          | [patterns.md](./patterns.md)           |
| Debug credential, connectivity, or TTL failures                | [gotchas.md](./gotchas.md)             |

Credentials are short-lived (max ~48 h TTL): generate them server-side per session — never embed a long-lived TURN credential in client code.

## See Also

- [Calls/Realtime SFU](https://developers.cloudflare.com/realtime/index.md) — managed SFU; TURN is free when paired with it
- [Stream](../stream/README.md) — video delivery with WHIP/WHEP
- [Orange Meets](https://github.com/cloudflare/orange) — open-source example app
