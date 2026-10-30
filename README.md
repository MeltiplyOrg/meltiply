# Meltiply

Compose social posts, organize connected accounts, schedule publishing, and track delivery outcomes in one workspace.

[Website](https://meltiply.com/) · [User documentation](https://meltiply.com/docs/) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)

## What Meltiply does

- Compose posts with media attachments and schedule them for connected social accounts.
- Organize accounts into Brand Profiles.
- Monitor publishing outcomes and retry eligible failures.

The current app focuses on **Posts**, **Analytics**, **Channels**, and named weekly **Queues**. Inbox and a standalone media library are not available app surfaces. See the [capability inventory](docs/frontend-capabilities.md) for current scope and restoration prerequisites. Provider features depend on each platform's APIs and account permissions.

## Get started

The devcontainer uses the original VibeCode Essential image declared in [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) directly, without a project image build. Lifecycle hooks start its bundled Docker-in-Docker daemon with per-devcontainer Docker/containerd volumes. The inherited host-socket mount is masked with read-only `/dev/null`, so the host Docker API is not exposed. Host OMP and Wrangler state plus GitHub and WakaTime config remain mounted as before. For manual setup, use the Node.js version in [`.node-version`](.node-version) and Bun version declared in [`package.json`](package.json); Docker Compose and Make are also required.

Rebuild the devcontainer to switch an existing environment, then run `make setup`.
The inner daemon starts with separate images and database volumes; existing
host-daemon resources are neither migrated nor deleted. DinD requires privileged
mode: it isolates Docker resources, not untrusted code from the host kernel.

```bash
make setup
make doctor
make dev
```

`make setup` installs dependencies, creates the ignored root `.env` from [`.env.example`](.env.example), fills blank auth/bootstrap/encryption secrets with private random values, starts PostgreSQL, applies migrations, and seeds local fixtures. Existing secret values are preserved on subsequent runs. Open the URLs printed by `make dev`.

Development stays on loopback by default. Set `MELTIPLY_DEV_TUNNEL=1 make dev` only when OAuth or webhook callbacks need a public URL. Tunnel settings and an explicit network-host override are documented in [`.env.example`](.env.example).

There is one application address: `APP_URL` serves the dashboard and `/api/*`.
Local host/port and public tunnel values are derived automatically. Set it only
when overriding that origin; `PUBLIC_SITE_URL` is for the separate landing/docs
site. CORS trusts the app origin automatically, and provider callback/media URLs
are derived from it. Credentials, provider approvals, and activation flags remain
explicit.

For existing configurations, replace `FRONTEND_URL`, `PUBLIC_API_URL`,
`API_BASE_URL`, `BETTER_AUTH_URL`, and `SELFHOST_ORIGIN` with one `APP_URL`.
The removed keys are not aliases. Restart the stack after migrating; if the
public host changes, update the registered provider callbacks and verified media
domain too. The TLS gateway derives its hostname from `APP_URL`.

Seeded local accounts all use `MeltiplyLocal1!` and share the single Workspace:

| Email                    | Workspace role | Notes                                                     |
| ------------------------ | -------------- | --------------------------------------------------------- |
| `alpha@meltiply.local`   | Admin          | Installation Owner                                        |
| `beta@meltiply.local`    | Admin          | Can invite/manage Editors and Viewers                     |
| `gamma@meltiply.local`   | Editor         | Can create and publish content                            |
| `delta@meltiply.local`   | Viewer         | Read-only                                                 |
| `epsilon@meltiply.local` | Viewer         | Suspended; sign-in is blocked until the Owner reactivates |

The seed also includes a pending invitation for `pending.invitee@meltiply.local` and
sample Audit entries, so the Members, Workspace, and Audit tabs are populated on
first sign-in. These credentials are for local development only. While the app runs
in Vite development mode (`make dev` or `make frontend-boot`), the sign-in form
prefills the Installation Owner's email and password; production and preview builds
never do. Production installations create their own owner through the protected
first-run setup described in
[self-hosting](docs/self-hosting.md#authentication-invitations-and-owner-recovery).

For visual Analytics development, the personal demo workspace includes 252 campaign
publications across all three Brand Profiles and all five Platforms, with text,
image, carousel, and video formats. Ninety days of dense publication history,
older campaign checkpoints, three cumulative metric readings per publication,
and daily/weekly follower history populate every range and filter without
replacing the existing failure or awaiting-sync examples. Run `bun run db:seed`
to refresh these deterministic fixtures in an existing local database; it does
not reset the database. These historical imports do not consume the current
period's publishing budget.

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

Meltiply is a Bun monorepo. Cloudflare Workers provide the API and asynchronous publishing pipeline; PostgreSQL runs through Hyperdrive, and media is stored in R2 or any S3-compatible object store.

| Directory            | Responsibility                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- |
| `frontend/app`       | Authenticated React application                                                       |
| `frontend/public`    | Astro landing page and user documentation                                             |
| `frontend/shared`    | Canonical UI controls, fonts/palette, icons, dialogs, feedback, and animation recipes |
| `workers/api`        | HTTP API and provider webhooks                                                        |
| `workers/automation` | Scheduled publishing and background jobs                                              |
| `workers/state`      | OAuth coordination                                                                    |
| `packages`           | Shared domain, database, provider, storage, auth, and API-contract code               |

## Contributors and coding agents

- **Contributors:** Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, development workflow, and pull requests.
- **Coding agents:** Follow [`AGENTS.md`](AGENTS.md) for repository rules and verification. Read [`CONTEXT.md`](CONTEXT.md) for domain terms, [`PRODUCT.md`](PRODUCT.md) for product intent, and [`STATE.md`](STATE.md) before refactors, schema changes, or data resets.
- **UI work:** Read [shared UI ownership](docs/frontend-ui.md), [layout](docs/frontend-layout.md), and the [capability inventory](docs/frontend-capabilities.md). App components use the current shared TypeScript/React/Tailwind system; public Astro adapters share its tokens.
- **API work:** See [`packages/contracts/README.md`](packages/contracts/README.md) for OpenAPI and generated-client workflow.
- **UI translations:** See [`docs/i18n.md`](docs/i18n.md) for the catalog layout, offline generation, and the CI check.
- **Deployment:** See [`infra/cloudflare/README.md`](infra/cloudflare/README.md) for infrastructure ownership and release safety.

## CI

This repository uses GitHub Actions. See [CI checks](docs/public-ci.md).

## License

Meltiply is source-available under the [Sustainable Use License](LICENSE.md), based on [n8n's SUL](https://docs.n8n.io/n8n-community-license/). It permits personal/non-commercial and internal business use; paid hosting requires separate permission. It is not OSI-approved open source.

Third-party material retains its own terms; see [third-party notices](THIRD_PARTY_NOTICES.md). Before publishing source, history, compiled bundles, or native images, follow the [licensing and publication guide](docs/licensing.md). The dependency license gate does not establish contributor ownership or certify binary redistribution.
