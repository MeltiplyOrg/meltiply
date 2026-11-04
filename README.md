# Meltiply

Compose social posts, organize connected accounts, schedule publishing, and track delivery outcomes in one workspace.

[Website](https://meltiply.com/) · [User documentation](https://meltiply.com/docs/) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)

## What Meltiply does

- Compose posts with media attachments and schedule them for connected social accounts.
- Organize accounts into Brand Profiles.
- Monitor publishing outcomes and retry eligible failures.

The app focuses on **Posts**, **Analytics**, **Channels**, and named weekly **Queues**. Inbox and a standalone media library are not app surfaces. See the [capability inventory](docs/frontend-capabilities.md). Provider features depend on each platform's APIs and account permissions.

## Get started

The devcontainer uses the VibeCode Essential image declared in [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) with Docker-in-Docker and a masked host socket. For manual setup use the Node.js version in [`.node-version`](.node-version) and Bun from [`package.json`](package.json); Docker Compose and Make are also required.

```bash
make setup
make doctor
make dev
```

`make setup` installs dependencies, creates the ignored root `.env` from [`.env.example`](.env.example), fills blank secrets with private random values, starts PostgreSQL, applies migrations, and seeds local fixtures. Existing secrets are preserved. Open the URLs printed by `make dev`.

Development stays on loopback. Set `MELTIPLY_DEV_TUNNEL=1 make dev` only when OAuth or webhook callbacks need a public URL; tunnel settings are in [`.env.example`](.env.example).

One `APP_URL` serves the dashboard and `/api/*`. Local host/port and tunnel values derive automatically; `PUBLIC_SITE_URL` covers the separate landing/docs site. CORS trusts the app origin, and provider callback/media URLs derive from it. Credentials, provider approvals, and activation flags stay explicit.

Seeded local accounts all use `MeltiplyLocal1!` and share the single Workspace:

| Email                    | Workspace role | Notes                                 |
| ------------------------ | -------------- | ------------------------------------- |
| `alpha@meltiply.local`   | Admin          | Installation Owner                    |
| `beta@meltiply.local`    | Admin          | Can invite/manage Editors and Viewers |
| `gamma@meltiply.local`   | Editor         | Can create and publish content        |
| `delta@meltiply.local`   | Viewer         | Read-only                             |
| `epsilon@meltiply.local` | Viewer         | Suspended until the Owner reactivates |

The seed also includes a pending invitation and sample Audit entries, so Members, Workspace, and Audit are populated on first sign-in. These credentials are for local development only. Under Vite development mode the sign-in form prefills the Owner; production and preview builds never do. Production installations create their own owner through the protected first-run setup in [self-hosting](docs/self-hosting.md#authentication-invitations-and-owner-recovery).

`bun run db:seed` refreshes the deterministic Analytics fixtures in an existing local database without resetting it, including 252 campaign publications across three Brand Profiles and five Platforms so every range and filter is populated.

## Deployment targets

Deploy a complete [managed Cloudflare staging or production installation](infra/cloudflare/README.md#release-and-rollback)
with the operator-run release flow, or run the production-built application and
Workers on your own host with [one Docker Compose file](docs/self-hosting.md).
The managed target requires your own Cloudflare/Neon accounts and Email Sending
domain. The self-hosted stack includes PostgreSQL, persistent workerd bindings,
durable queues, SMTP delivery, native media processing, and optional TLS.
Both targets can be installed before Provider app review; connections and
publishing remain unavailable while their acceptance flags are false.

[`compose.dev.yml`](compose.dev.yml) provides only the development database and optional observability services; it is not the production deployment.

## Common commands

| Task                             | Command               |
| -------------------------------- | --------------------- |
| List available tasks             | `make help`           |
| Diagnose local setup             | `make doctor`         |
| Start the local stack            | `make dev`            |
| Run local Worker smoke checks    | `bun run local:smoke` |
| Run the main validation workflow | `make check`          |
| Build the public site and docs   | `make public-build`   |

`bun run local:teardown` discards the local database and volumes. Change-scoped verification is defined once in [`AGENTS.md`](AGENTS.md).

## Architecture

Bun monorepo. Cloudflare Workers provide the API and asynchronous publishing pipeline; PostgreSQL runs through Hyperdrive, and media is stored in R2 or any S3-compatible object store.

| Directory            | Responsibility                                                              |
| -------------------- | --------------------------------------------------------------------------- |
| `frontend/app`       | Authenticated React application                                             |
| `frontend/public`    | Astro landing page and user documentation                                   |
| `frontend/shared`    | Canonical UI controls, palette, icons, dialogs, feedback, animation recipes |
| `workers/api`        | HTTP API and provider webhooks                                              |
| `workers/automation` | Scheduled publishing and background jobs                                    |
| `workers/state`      | OAuth coordination                                                          |
| `packages`           | Shared domain, database, provider, storage, auth, contract code             |

## Contributors and coding agents

- **Contributors:** [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, workflow, and pull requests.
- **Coding agents:** [`AGENTS.md`](AGENTS.md) for repository rules and verification; [`CONTEXT.md`](CONTEXT.md) for domain terms, [`PRODUCT.md`](PRODUCT.md) for product intent, [`STATE.md`](STATE.md) before refactors, schema changes, or data resets.
- **UI work:** [shared UI ownership](docs/frontend-ui.md), [layout](docs/frontend-layout.md), [capability inventory](docs/frontend-capabilities.md).
- **API work:** [`packages/contracts/README.md`](packages/contracts/README.md) for OpenAPI and generated clients.
- **UI translations:** [`docs/i18n.md`](docs/i18n.md).
- **Deployment:** [`infra/cloudflare/README.md`](infra/cloudflare/README.md) for infrastructure ownership and release safety.
- **CI:** [CI checks](docs/public-ci.md).

## License

Meltiply is free software under the [GNU Affero General Public License, version 3 or later](LICENSE.md). It is OSI-approved open source: you may run it, modify it, and redistribute it. Running a modified version as a network service requires offering its Corresponding Source to that service's users. Hosting requires no fee or separate permission.

Third-party material keeps its own terms; see [third-party notices](THIRD_PARTY_NOTICES.md) and the [licensing and publication guide](docs/licensing.md). The dependency license gate does not establish contributor ownership or certify binary redistribution.
