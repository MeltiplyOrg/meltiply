# Meltiply

Compose social posts, organize connected accounts, schedule publishing, and track delivery outcomes in one workspace.

[Website](https://meltiply.com/) · [User documentation](https://meltiply.com/docs/) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)

## What Meltiply does

- Compose posts with media attachments and schedule them for connected social accounts.
- Organize accounts into Brand Profiles.
- Monitor publishing outcomes and retry eligible failures.

The current app focuses on **Posts** and **Channels**. Analytics, inbox, team administration, and a standalone media library are not available app surfaces. See the [capability inventory](docs/frontend-capabilities.md) for current scope and restoration prerequisites. Provider features depend on each platform's APIs and account permissions.

## Get started

The devcontainer uses the VibeCode Essential image declared in [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) for the full coding toolchain. That config also mounts host OMP and Wrangler state plus GitHub and WakaTime config. For manual setup, use the Node.js version in [`.node-version`](.node-version) and Bun version declared in [`package.json`](package.json); Docker Compose and Make are also required.

```bash
make setup
make doctor
make dev
```

`make setup` installs dependencies, creates the ignored root `.env` from [`.env.example`](.env.example), starts PostgreSQL, applies migrations, and seeds local fixtures. Open the URLs printed by `make dev`.

Development stays on loopback by default. Set `MELTIPLY_DEV_TUNNEL=1 make dev` only when OAuth or webhook callbacks need a public URL. Tunnel settings and an explicit network-host override are documented in [`.env.example`](.env.example).

Seeded local accounts: `alpha@meltiply.local` (populated workspace) and `beta@meltiply.local` (near-empty workspace); both use `MeltiplyLocal1!`. These credentials are for local development only.

## Deployment targets

Keep the [managed Cloudflare deployment](infra/cloudflare/README.md), or run the
production-built application and Workers on your own host with
[one Docker Compose file](docs/self-hosting.md). The self-hosted stack includes
PostgreSQL, persistent workerd bindings, durable queues, SMTP delivery, native
media processing, and optional TLS. Its GitHub Actions workflow builds and verifies
three GHCR release images; it does not require remote Cloudflare Workers.

[`compose.dev.yml`](compose.dev.yml) provides only the development database and
optional observability services used by `make dev`; it is not the self-hosted
production deployment.

## Common commands

| Task                             | Command               |
| -------------------------------- | --------------------- |
| List available tasks             | `make help`           |
| Diagnose local setup             | `make doctor`         |
| Start the local stack            | `make dev`            |
| Run local Worker smoke checks    | `bun run local:smoke` |
| Run the main validation workflow | `make check`          |
| Build the public site and docs   | `make public-build`   |

Use `bun run local:teardown` only when the local database and volumes can be discarded. `make help` lists daily workflows; `bun run` lists package checks and operational commands. Change-scoped verification is defined once in [`AGENTS.md`](AGENTS.md).

## Architecture

Meltiply is a Bun monorepo. Cloudflare Workers provide the API and asynchronous publishing pipeline; PostgreSQL runs through Hyperdrive, and media is stored in R2.

| Directory            | Responsibility                                                          |
| -------------------- | ----------------------------------------------------------------------- |
| `frontend/app`       | Authenticated React application                                         |
| `frontend/public`    | Astro landing page and user documentation                               |
| `workers/api`        | HTTP API and provider webhooks                                          |
| `workers/automation` | Scheduled publishing and background jobs                                |
| `workers/state`      | OAuth coordination                                                      |
| `packages`           | Shared domain, database, provider, storage, auth, and API-contract code |

## Contributors and coding agents

- **Contributors:** Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, development workflow, and pull requests.
- **Coding agents:** Follow [`AGENTS.md`](AGENTS.md) for repository rules and verification. Read [`CONTEXT.md`](CONTEXT.md) for domain terms, [`PRODUCT.md`](PRODUCT.md) for product intent, and [`STATE.md`](STATE.md) before refactors, schema changes, or data resets.
- **API work:** See [`packages/contracts/README.md`](packages/contracts/README.md) for OpenAPI and generated-client workflow.
- **Deployment:** See [`infra/cloudflare/README.md`](infra/cloudflare/README.md) for infrastructure ownership and release safety.

## CI

This repository uses GitHub Actions. See [CI checks](docs/public-ci.md).

## License

Meltiply is source-available under the [Sustainable Use License](LICENSE.md), based on [n8n's SUL](https://docs.n8n.io/n8n-community-license/). It permits personal/non-commercial and internal business use; paid hosting requires separate permission. It is not OSI-approved open source.

Third-party material retains its own terms; see [third-party notices](THIRD_PARTY_NOTICES.md). Before publishing source, history, compiled bundles, or native images, follow the [licensing and publication guide](docs/licensing.md). The dependency license gate does not establish contributor ownership or certify binary redistribution.
