# Cloudflare Bot Management

Use Bot Management to detect and act on automated traffic via bot scores, JavaScript detections, and verified-bot signals. Three tiers exist: Bot Fight Mode (Free), Super Bot Fight Mode (Pro/Business — score groupings only), and Bot Management for Enterprise (granular 1–99 scores, JA3/JA4 fingerprinting, Workers API). Check [plan availability](https://developers.cloudflare.com/bots/get-started/index.md) before designing rules around a specific signal.

Always exempt verified bots (`cf.bot_management.verified_bot`) from bot-score actions — they are allowlisted good bots such as search engines and AI crawlers. A score of 0 means Bot Management did not run on the request, not that the visitor is human.

## Choose a task

| Task                                                        | Start here                        |
| ----------------------------------------------------------- | --------------------------------- |
| Enable a tier or configure WAF rules and detections         | [Configuration](configuration.md) |
| Read bot signals in a Worker or WAF expression              | [API](api.md)                     |
| Protect checkout, APIs, or mobile apps without breaking SEO | [Patterns](patterns.md)           |
| Diagnose false positives, score 0, or JS detection issues   | [Gotchas](gotchas.md)             |

## See also

- [Bot Management docs](https://developers.cloudflare.com/bots/index.md)
- [WAF](../waf/README.md) — custom rules for bot enforcement
- [API Shield](../api-shield/README.md) — API-specific bot protection
- [Turnstile](https://developers.cloudflare.com/turnstile/index.md) — challenge-based form protection
