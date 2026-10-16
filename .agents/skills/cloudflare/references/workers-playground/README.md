# Cloudflare Workers Playground

Use the [Playground](https://workers.cloudflare.com/playground) to experiment with, test, and share Workers in the browser — no account, CLI, or setup; code runs in the real Workers runtime with instant preview and shareable URLs.

**Not production-equivalent:** JavaScript only (no TypeScript), no bindings (KV/D1/R2/Durable Objects), no environment variables or secrets, ES modules only, and the preview is broken in Safari — use Chrome/Firefox/Edge. For anything real, use `wrangler`.

```javascript
export default {
  async fetch(request, env, ctx) {
    return Response.json({ message: "Hello", timestamp: Date.now() });
  },
};
```

## In This Reference

- [configuration.md](./configuration.md) — playground constraints, preview, sharing, deploy path
- [api.md](./api.md) — handler, Request/Response, ExecutionContext, Cache APIs
- [patterns.md](./patterns.md) — routing, proxying, A/B tests, multi-module and CDN-import examples
- [gotchas.md](./gotchas.md) — errors, browser issues, and limits vs. production

## See Also

- [Workers docs](https://developers.cloudflare.com/workers/index.md) and [examples](https://developers.cloudflare.com/workers/examples/index.md)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/index.md) — the production path
