# Cloudflare Cache Reserve

Use Cache Reserve for persistent, long-retention cache storage built on R2. It sits above tiered cache in the hierarchy, keeping cacheable content available after edge eviction to cut origin egress and shield origins from long-tail requests. It is included with Smart Shield Advanced and also sold standalone.

Enabling Cache Reserve requires a paid plan or Smart Shield Advanced plus Tiered Cache. Assets are stored only when they are cacheable, carry ≥10-hour TTL and a `Content-Length` header, and lack blocking headers (`Set-Cookie`, `Vary: *`); range requests and image-transformation variants are not stored. Verify the full eligibility list in [gotchas](gotchas.md) before expecting a hit. Cache Reserve is not the Workers Cache API — do not expect per-request control from a Worker.

## Choose a task

| Task                                                       | Start here                        |
| ---------------------------------------------------------- | --------------------------------- |
| Enable Cache Reserve via dashboard, API, SDK, or Terraform | [Configuration](configuration.md) |
| Purge, monitor, or interact from Workers                   | [API](api.md)                     |
| Optimize cost and combine with Tiered Cache                | [Patterns](patterns.md)           |
| Diagnose missing cache hits or eligibility failures        | [Gotchas](gotchas.md)             |

## See also

- [Cache Reserve docs](https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/index.md)
- [R2](../r2/README.md) — the storage layer behind Cache Reserve
- [Workers Cache](https://developers.cloudflare.com/workers/cache/index.md) — programmatic caching from Workers
