# Cloudflare Web Analytics

Use Web Analytics for privacy-first traffic metrics and Core Web Vitals without cookies, fingerprinting, or PII collection. See the [Web Analytics docs](https://developers.cloudflare.com/web-analytics/index.md).

**Hard boundary:** Web Analytics is **dashboard-only** — there is no API for programmatic access to its data. For queryable server-side analytics, use the [GraphQL Analytics API](../graphql-api/README.md). Expect a 5–10 minute data delay and pageview/navigation tracking only (no custom events, session replay, or form tracking); hash-based routing (`#/path`) is not tracked.

**Setup splits on proxy status:**

- **Proxied through Cloudflare** → enable automatic injection in the dashboard; no code changes needed unless responses carry `Cache-Control: no-transform`. See [configuration.md](./configuration.md).
- **Not proxied** → manual beacon snippet, limited to 10 sites per account. For SPAs (React Router, Next.js, Vue, Nuxt), the beacon must set `"spa": true` or client-side navigations are not tracked; CSP must allow `static.cloudflareinsights.com` and `cloudflareinsights.com`. See [integration.md](./integration.md).

## In This Reference

- [configuration.md](./configuration.md) — proxied vs. non-proxied setup
- [integration.md](./integration.md) — framework-specific beacon integration
- [patterns.md](./patterns.md) — performance monitoring, GDPR consent, multi-site tracking
- [gotchas.md](./gotchas.md) — SPA tracking, CSP, and missing-data troubleshooting
