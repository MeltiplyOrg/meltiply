# Workers Static Assets

Use Workers Static Assets for new static sites, SPAs, generated sites, and apps combining assets with server logic. Inspect the framework, build output, and existing deployment configuration before changing routing — do not choose a platform from the framework name alone. For an existing Pages project, inspect its current features and migration requirements before proposing a move; see the [Pages migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/index.md).

| Task                                                          | Documentation                                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Set up and deploy a static site or application                | [Get started](https://developers.cloudflare.com/workers/static-assets/get-started/index.md)                                      |
| Configure the asset directory, binding, or `run_worker_first` | [Configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/index.md)                           |
| Serve a client-rendered application                           | [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/index.md)                  |
| Serve generated HTML and custom error pages                   | [SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/index.md)                   |
| Use a full-stack framework                                    | [Full-stack application guides](https://developers.cloudflare.com/workers/static-assets/routing/full-stack-application/index.md) |

## In This Reference

- [configuration.md](./configuration.md) — build output and routing configuration
- [api.md](./api.md) — fetch assets and handle responses
- [patterns.md](./patterns.md) — choose a routing design
- [gotchas.md](./gotchas.md) — diagnose routing, caching, and deployment issues
