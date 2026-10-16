# Production self-hosting

Meltiply supports two deployment targets: [managed Cloudflare](../infra/cloudflare/README.md)
and a single-host [Docker Compose deployment](../compose.selfhost.yml). Neither
replaces the development stack (`make dev`). Both targets build the same API,
automation handlers, state coordinator, reply workflow, and application frontend.

Wrangler bundles production Workers with `deploy --dry-run --minify`; Vite and
Astro build the production frontends. The runtime image executes those immutable
artifacts with Cloudflare's workerd through Miniflare: no Wrangler dev server,
watcher, HMR, or source compilation runs at startup. Miniflare is the binding
host, not the Cloudflare managed service or an availability guarantee.

## Services and differences

| Service                  | Self-hosted implementation                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| App, API, public website | Production assets and Workers; ports 8080 and 8081                                                               |
| PostgreSQL / Hyperdrive  | PostgreSQL 18, canonical migrations, distinct system and RLS roles; request-scoped direct connections            |
| R2                       | Persistent local R2 binding and authenticated SigV4 upload/download endpoint                                     |
| Durable Objects          | SQLite-backed canonical OAuth coordinator                                                                        |
| Workflows                | Persistent local binding running the canonical reply workflow                                                    |
| Queues                   | SQLite WAL broker; commit-before-ack, delayed delivery, visibility leases, retries and dead-letter queues        |
| Cron                     | Durable hourly/daily schedule ledger invoking canonical scheduled handlers; missed slots coalesce after downtime |
| Email                    | Real SMTP transport; signup still requires email verification                                                    |
| Operator authentication  | Private administrator-issued HMAC tokens, at most 15 minutes, instead of Cloudflare Access                       |
| Media processing         | Existing FFmpeg/libvips processor in a private container; no Docker socket                                       |
| TLS                      | Optional Caddy profile in the same Compose file                                                                  |

This is a **single-host** deployment, not a replacement for Cloudflare's global
network, managed durability, autoscaling, Access, or service SLAs. Run one runtime
replica per data volume; do not share its SQLite files across hosts. Back up both
the PostgreSQL and runtime state. Social Providers and billing remain external
services and require your own credentials, public callback URLs, and approvals.
No Cloudflare account or remote Workers are needed by this deployment.

## First start from source

Requirements: Docker Engine with a recent Docker Compose v2 supporting inline
`configs.content`, Node 24 for the configuration generator, and a delivering SMTP
server. Images produced by the supplied hosted workflow target Linux amd64; use
an amd64 host or explicitly configured Docker emulation on ARM.

From the repository root:

```bash
node scripts/selfhost/configure.mjs
# Edit .env.selfhost: set MAIL_FROM_ADDRESS and SELFHOST_SMTP_URL.
docker compose --env-file .env.selfhost -f compose.selfhost.yml build
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --wait
```

The generator creates private random credentials in `.env.selfhost` with mode
0600 and refuses to overwrite an existing file. Keep it outside version control
and backups accessible only to administrators. Use an authenticated `smtps://`
URL or a properly configured STARTTLS SMTP server; URL-encode credential
characters. Startup verifies the SMTP connection. The `verification` profile
contains a capture-only Mailpit service for CI, **not email delivery**.

Open <http://localhost:8080> for the app and <http://localhost:8081> for the public
site. Create a new account and follow its emailed verification link. Development
fixtures and development passwords are not installed. PostgreSQL is not published
to the host. Only loopback application ports are published by default.

Set optional Provider/billing variables in `.env.selfhost` using the names in
[`.env.example`](../.env.example). Self-hosting does not bypass Provider live-mode
checks or account permissions. Do not change `ENVIRONMENT` to disable verification;
the supervisor deliberately retains deployed security behavior.

## HTTPS and public callbacks

Point two DNS names at the host, allow TCP 80/443 and optionally UDP 443, and add:

```dotenv
SELFHOST_ORIGIN=https://app.example.com
SELFHOST_PUBLIC_ORIGIN=https://www.example.com
SELFHOST_APP_DOMAIN=app.example.com
SELFHOST_PUBLIC_DOMAIN=www.example.com
```

Then start the same file with its TLS profile:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile tls up -d --wait
```

Caddy provisions certificates and forwards both surfaces. Origins must match
browser-visible URLs because authentication, verification links, and signed
storage capabilities depend on them. Register the application callback URLs with
each Provider. An existing reverse proxy can replace the optional gateway; route
the app to port 8080 and the public site to 8081. The runtime does not trust
client-supplied forwarding headers. Behind a proxy, IP-based rate limits see the
proxy address; this is intentionally conservative rather than accepting spoofed
client IPs.

## Published images and CI

[Self-hosted images](../.github/workflows/selfhost.yml) builds three images on
GitHub-hosted Linux amd64 runners:

- `ghcr.io/meltiplyorg/meltiply-runtime`
- `ghcr.io/meltiplyorg/meltiply-database`
- `ghcr.io/meltiplyorg/meltiply-processor`

Pushes and pull requests build and exercise images without publishing. A published
GitHub release, or a manually dispatched workflow with `publish=true` and an
explicit image tag, publishes only after all verification passes. Tags include
the release tag and `sha-<full-commit>`; non-prerelease releases also update
`latest`. Images include source/revision labels; the runtime carries dependency
license notices and an SBOM. The workflow uses `GITHUB_TOKEN` with package-write
permission, not Cloudflare deployment secrets. Configure the GHCR packages as
public if unauthenticated pulls are required.

For an image-only installation, obtain `compose.selfhost.yml` from the exact
release revision. No checkout or build context is required when using `--no-build`.
Generate the environment file with the matching runtime image (replace `TAG`):

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/configuration" -w /configuration \
  --entrypoint node ghcr.io/meltiplyorg/meltiply-runtime:TAG \
  /app/scripts/selfhost/configure.mjs
# Set SMTP/sender and SELFHOST_IMAGE_TAG=TAG in .env.selfhost.
docker compose --env-file .env.selfhost -f compose.selfhost.yml pull
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --no-build --wait
```

Set `SELFHOST_IMAGE_PREFIX` for a fork's GHCR namespace. Use the same immutable
tag for all three images; do not mix migration and runtime versions. To upgrade,
first take a consistent backup, change the tag, pull, and recreate the stack.
The migration service runs the existing migration ledger before starting the
runtime. A runtime rollback does not reverse database migrations; restore a
compatible backup if schema compatibility requires it.

## Administration and recovery

Administrator operations use a mode-0600 Unix socket inside the runtime container;
there is no public administration port. Docker access is privileged access.

```bash
# Queue counts, including pending/retrying and dead-letter queues:
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T runtime \
  node scripts/selfhost/admin.mjs status

# Mint an operator token; protect the output like a password:
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T runtime \
  node scripts/selfhost/admin.mjs token operator@example.com operator-id

# Replay a bounded batch after correcting the underlying failure:
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T runtime \
  node scripts/selfhost/admin.mjs replay QUEUE_NAME-selfhost-dlq 100
```

Send the token as `Cf-Access-Jwt-Assertion` to canonical `/operator/v1/*` routes
on the configured app hostname. Tokens expire after 15 minutes. Invalid tokens
and wrong hostnames are rejected. Queue delivery remains at least once: consumers
retain their existing idempotency logic. A killed runtime recovers committed jobs;
a claimed job becomes eligible again after its 15-minute visibility lease. Do not
remove a poison message without first understanding its failure.

Named volumes contain PostgreSQL, runtime resources and broker state, and optional
TLS certificates/configuration. For a consistent full backup, stop runtime and
processor, dump PostgreSQL with a protected administrative connection, and archive
the stopped runtime volume together with `.env.selfhost`. Restore the matching
application revision and both state stores before admitting traffic. Preserve
encryption keys: losing `TOKEN_ENCRYPTION_KEY` makes stored Provider credentials
unreadable. Changing generated database password variables alone does not rotate
passwords already stored in PostgreSQL.

Use `docker compose ... down` to stop while retaining volumes. **Do not use
`down --volumes` on a real installation** unless intentionally deleting all data.
Allow the configured 11-minute graceful stop for in-flight media jobs. Monitor
`/api/v1/ready`, container health, logs, disk space, and queue backlog; local
persistence cannot survive loss of its host without backups.
