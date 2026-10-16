# Cloudflare Zaraz

Use Zaraz to load third-party tools (analytics, ads, chat, marketing pixels) server-side at Cloudflare's edge instead of in the browser — one endpoint serves all tools, removing client-side JS overhead and giving you control over the data each vendor receives. See the [Zaraz docs](https://developers.cloudflare.com/zaraz/index.md).

**Choose Workers directly when** you need custom server-side tracking logic, full control over data processing, complex backend integration, or tools outside Zaraz's library.

**Three verbs to know:** `zaraz.track()` (events), `zaraz.set()` (user properties), `zaraz.ecommerce()` (commerce events) — plus consent methods that gate tools by purpose. Details live in [api.md](./api.md).

## Task routing

| Task                                                                                     | Read                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------- |
| Set up Zaraz, add tools, configure triggers and consent                                  | [configuration.md](./configuration.md) |
| Fire events, set properties, ecommerce, consent API                                      | [api.md](./api.md)                     |
| SPA tracking, e-commerce funnels, Worker integration (Context Enrichers, HTML injection) | [patterns.md](./patterns.md)           |
| Events not firing, consent or data-layer issues, performance                             | [gotchas.md](./gotchas.md)             |

## See Also

- [Zaraz Web API](https://developers.cloudflare.com/zaraz/web-api/index.md)
- [Managed Components](https://developers.cloudflare.com/zaraz/advanced/load-custom-managed-component/index.md) — build custom tools
- [Workers](https://developers.cloudflare.com/workers/index.md) — when you outgrow Zaraz
