# Workerd Runtime

The V8-based JavaScript/Wasm runtime that powers Cloudflare Workers, usable directly as an app server, dev tool, or HTTP proxy.

> **Security: workerd is NOT a hardened sandbox.** Do not run untrusted code with it. Cloudflare's production environment adds isolation layers the open-source runtime does not have — workerd is for deploying _your_ code self-hosted, not for multi-tenant execution of customer or user-submitted code.

**Most users should use Wrangler instead** — `wrangler dev` runs workerd internally and `wrangler deploy` ships to Cloudflare. Reach for raw workerd only when self-hosting the runtime in production, embedding it in a C++ application, building custom tooling or test infrastructure, or debugging workerd-specific behavior.

Core concepts: a `workerd.capnp` config declares **services** (workers, network/disk/external endpoints), **sockets** (HTTP/HTTPS listeners), and **extensions**; resource access flows through capability-based **bindings**; every service needs an explicit **compatibility date**. Workerd is under active development — pin versions in production and use WSL2 on Windows.

```bash
workerd serve config.capnp          # run
workerd compile config.capnp -o out # produce a self-contained binary
workerd test config.capnp           # run tests
```

## In This Reference

- [patterns.md](./patterns.md) — multi-service layouts and framework examples
- [configuration.md](./configuration.md) — capnp config format, services, bindings
- [api.md](./api.md) — runtime APIs and TypeScript types
- [gotchas.md](./gotchas.md) — common errors and debugging

## See Also

- [Workers](https://developers.cloudflare.com/workers/index.md) — managed runtime documentation
- [Miniflare](../miniflare/README.md) — local dev/testing built on workerd
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/index.md) — CLI that runs workerd for `dev`
