# C3 (create-cloudflare)

Use `npm create cloudflare@latest` (or the yarn/pnpm equivalent) to scaffold Workers and Pages projects. Run interactively for a first project; pass flags for CI and scripting.

**Pages projects require `--platform=pages`.** Without the flag C3 scaffolds a Worker, which is the right default for APIs, WebSockets, crons, and full-stack apps — choose Pages only for static sites and SSG.

```bash
# Interactive (recommended first time)
npm create cloudflare@latest my-app

# Worker (API / WebSocket / cron)
npm create cloudflare@latest my-api -- --type=hello-world --ts

# Pages static site
npm create cloudflare@latest my-site -- --type=web-app --framework=astro --platform=pages

# Convert an existing project (run in its directory)
npm create cloudflare@latest . -- --type=pre-existing --existing-script=./src/worker.ts
```

## Framework Setup

Fetch the [Workers framework guide](https://developers.cloudflare.com/workers/framework-guides/index.md) for the chosen framework before scaffolding or adapting an existing app. For Next.js, follow [Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/index.md); use the [Pages static export guide](https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/index.md) only when targeting a Next.js static export on Pages.

## Choose a task

| Task                                           | Start here                        |
| ---------------------------------------------- | --------------------------------- |
| Look up CLI flags or invocation differences    | [API](api.md)                     |
| Understand generated files, bindings, or types | [Configuration](configuration.md) |
| Set up CI/CD, monorepos, or custom templates   | [Patterns](patterns.md)           |
| Diagnose a failed scaffold or deploy           | [Gotchas](gotchas.md)             |

After scaffolding: `npm run dev` for local development, `npm run cf-typegen` to generate binding types, `npm run deploy` to deploy — check the generated `package.json` for the exact scripts.

## See also

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/index.md) — CLI beyond initial scaffolding
- [Pages](../pages/README.md) — existing Pages deployments (prefer Workers for new sites)
- [Static Assets](../static-assets/README.md) — serving front-end assets from Workers
