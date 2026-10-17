# Production self-hosting

Meltiply supports two deployment targets: [managed Cloudflare](../infra/cloudflare/README.md)
and a single-host [Docker Compose deployment](../compose.selfhost.yml). Neither
replaces the development stack (`make dev`). Both targets build the same API,
automation handlers, state coordinator, reply workflow, and application frontend.

Wrangler bundles production Workers with `deploy --dry-run --minify`; Vite builds
the production app. The public marketing/documentation site is not built or
included in these images. The runtime image executes immutable app and Worker
artifacts with Cloudflare's workerd through Miniflare: no Wrangler dev server,
watcher, HMR, or source compilation runs at startup. Miniflare is the binding
host, not the Cloudflare managed service or an availability guarantee.

## Services and differences

| Service                 | Self-hosted implementation                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| App, API                | Production app assets and Workers; port 8080                                                                      |
| PostgreSQL / Hyperdrive | PostgreSQL 18, canonical migrations, distinct system and RLS roles; request-scoped direct connections             |
| R2                      | Persistent local R2 binding and authenticated SigV4 upload/download endpoint, or an external S3-compatible origin |
| Durable Objects         | SQLite-backed canonical OAuth coordinator                                                                         |
| Workflows               | Persistent local binding running the canonical reply workflow                                                     |
| Queues                  | SQLite WAL broker; commit-before-ack, delayed delivery, visibility leases, retries and dead-letter queues         |
| Cron                    | Durable hourly/daily schedule ledger invoking canonical scheduled handlers; missed slots coalesce after downtime  |
| Email                   | Real SMTP transport; signup still requires email verification                                                     |
| Operator authentication | Private administrator-issued HMAC tokens, at most 15 minutes, instead of Cloudflare Access                        |
| Media processing        | Existing FFmpeg/libvips processor in a private container; no Docker socket                                        |
| TLS                     | Optional Caddy profile in the same Compose file                                                                   |

This is a **single-host** deployment, not a replacement for Cloudflare's global
network, managed durability, autoscaling, Access, or service SLAs. Run one runtime
replica per data volume; do not share its SQLite files across hosts. Back up both
the PostgreSQL and runtime state. Social Providers and billing remain external
services and require your own credentials, public callback URLs, and approvals.
No Cloudflare account or remote Workers are needed by this deployment.

## First start from source

Requirements: Docker Engine with a recent Docker Compose v2 supporting inline
`configs.content`, Node 24 for the configuration generator, and a delivering SMTP
server. Images support Linux amd64 and ARM64, with native CI builds and complete
Compose smoke checks on both architectures; no emulation is required.

From the repository root:

```bash
node scripts/selfhost/configure.mjs
# Edit .env.selfhost: set MAIL_FROM_ADDRESS and SELFHOST_SMTP_URL.
docker compose --env-file .env.selfhost -f compose.selfhost.yml build
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --wait
```

The generator records the native architecture as `SELFHOST_PLATFORM=linux/amd64`
or `linux/arm64`. Existing environment files must add this setting explicitly.
Only 64-bit ARM is supported; 32-bit ARM is not a release target.

The generator creates private random credentials in `.env.selfhost` with mode
0600 and refuses to overwrite an existing file. Keep it outside version control
and backups accessible only to administrators. Use an authenticated `smtps://`
URL or a properly configured STARTTLS SMTP server; URL-encode credential
characters. Startup verifies the SMTP connection. The `verification` profile
contains a capture-only Mailpit service for CI, **not email delivery**.

Open <http://localhost:8080> for the app. Create a new account and follow its
emailed verification link. Development
fixtures and development passwords are not installed. PostgreSQL is not published
to the host. Only loopback application ports are published by default.

Set optional Provider/billing variables in `.env.selfhost` using the names in
[`.env.example`](../.env.example). Self-hosting does not bypass Provider live-mode
checks or account permissions. Do not change `ENVIRONMENT` to disable verification;
the supervisor deliberately retains deployed security behavior.

## Object storage

Stored assets live in Cloudflare R2 by default: the runtime provides a persistent
local R2 binding and signs upload, preview, and download capabilities against its
own authenticated SigV4 endpoint. Nothing needs configuring.

To store objects in an external S3-compatible service instead (MinIO, Ceph RGW,
Wasabi, Backblaze B2's S3 endpoint, or another gateway), set these in
`.env.selfhost` and restart the runtime:

```dotenv
OBJECT_STORAGE_PROVIDER=s3
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
S3_BUCKET=meltiply-assets
S3_ENDPOINT=https://objects.example.com
S3_REGION=us-east-1          # optional, defaults to us-east-1
S3_FORCE_PATH_STYLE=true     # optional; set false for virtual-hosted addressing
```

`S3_ENDPOINT` must be an origin with no path, and must use HTTPS: the
supervisor runs as `ENVIRONMENT=staging`, which never permits signing a
plain-HTTP origin. `S3_FORCE_PATH_STYLE` defaults to `true`, which is what
MinIO, Ceph, and other self-hosted services expect; AWS endpoints want `false`.
The origin must be reachable from the runtime container and from any machine or
service that fetches signed URLs.

Leaving `OBJECT_STORAGE_PROVIDER` unset keeps R2, so an existing installation
is unaffected. The runtime refuses to start when the `s3` provider is selected
without its required settings.

Both providers offer identical behavior: uploads and multipart uploads, media
processing, retention and brand-profile purges, and private media delivery all
run through whichever provider is configured.

`/api/v1/ready` validates storage _configuration_, not connectivity. It reports
an unusable provider or endpoint as unavailable, but it never contacts the
origin, so a container stays healthy while an S3 service is down. Watch the
runtime logs and the first asset upload for that failure; `admin.mjs probe-write`
/ `probe-read` also exercises the configured provider's storage.

The S3 service must implement conditional `CopyObject` (`If-None-Match: *`
for the destination and `x-amz-copy-source-if-match` for the source), conditional
PUT, and multipart uploads. These guards preserve immutable ready objects and
create-only processor outputs; an S3-like service without them is not supported.
Configure bucket CORS to allow browser PUTs from the application origin, including
`content-type` and the signed headers, and expose `ETag` for multipart uploads.
Provider selection changes where new requests go; it does not migrate existing
objects. Copy all retained object keys to the new bucket before switching both
Workers, and retain the old endpoint until previously issued signed URLs expire.

The hosted `object-storage` lane in the
[extended workflow](../.github/workflows/extended.yml) verifies switching through
the application lifecycle with a disposable PostgreSQL database, real native
media processing, R2, and MinIO. `bun run storage:s3:check` checks signatures
against the bundled gateway locally; that gateway does not support server-side
copy. For full copy coverage, run the same command with `S3_CHECK_ENDPOINT`,
`S3_CHECK_ACCESS_KEY`, `S3_CHECK_SECRET_KEY`, and optional `S3_CHECK_BUCKET`
against a **disposable empty bucket**: the check creates the bucket and writes
and deletes fixture objects. Never use production credentials or a real bucket.

## HTTPS and public callbacks

Point the app's DNS name at the host, allow TCP 80/443 and optionally UDP 443, and add:

```dotenv
SELFHOST_ORIGIN=https://app.example.com
SELFHOST_APP_DOMAIN=app.example.com
```

Then start the same file with its TLS profile:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile tls up -d --wait
```

Caddy provisions certificates and forwards the app. Its origin must match the
browser-visible URL because authentication, verification links, and signed
storage capabilities depend on it. Register the application callback URLs with
each Provider. An existing reverse proxy can replace the optional gateway; route
the app to port 8080. The runtime does not trust
client-supplied forwarding headers. Behind a proxy, IP-based rate limits see the
proxy address; this is intentionally conservative rather than accepting spoofed
client IPs.

## Published images and CI

The main [CI workflow](../.github/workflows/ci.yml) builds and smoke-checks three
images when production inputs change, in parallel for Linux amd64 and ARM64.
[Path rules](../scripts/ci/github-paths.json) select image checks for code,
dependencies, migrations, Docker/Compose, and image-CI changes; documentation-only
PRs skip them.

- `ghcr.io/meltiplyorg/meltiply-runtime`
- `ghcr.io/meltiplyorg/meltiply-database`
- `ghcr.io/meltiplyorg/meltiply-processor`

Ordinary CI never publishes images, and its required `ci-gate` fails if image
builds or smoke checks fail. The separate
[release workflow](../.github/workflows/selfhost.yml) reuses the same
[image verification workflow](../.github/workflows/selfhost-ci.yml).
A published GitHub release, or a manually dispatched release workflow with
`publish=true` and an explicit image tag, publishes only after verification passes
on both architectures. Publication uses the exact verified image artifacts,
without rebuilding. The release tag and `sha-<full-commit>` are multi-architecture
manifests; Docker selects the native image automatically. Non-prerelease releases
also update `latest`. Architecture-specific commit tags retain the `-amd64` or
`-arm64` suffix. Images include source/revision labels; the runtime carries dependency
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
