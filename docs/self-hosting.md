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

| Service                 | Self-hosted implementation                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App, API                | Production app assets and Workers; port 8080                                                                     |
| PostgreSQL / Hyperdrive | PostgreSQL 18, canonical migrations, distinct system and RLS roles; request-scoped direct connections            |
| R2                      | Persistent local R2 binding and authenticated SigV4 upload/download endpoint                                     |
| Durable Objects         | SQLite-backed canonical OAuth coordinator                                                                        |
| Workflows               | Persistent local binding running the canonical reply workflow                                                    |
| Queues                  | SQLite WAL broker; commit-before-ack, delayed delivery, visibility leases, retries and dead-letter queues        |
| Cron                    | Durable hourly/daily schedule ledger invoking canonical scheduled handlers; missed slots coalesce after downtime |
| Email                   | Real SMTP transport; signup still requires email verification                                                    |
| Operator authentication | Private administrator-issued HMAC tokens, at most 15 minutes, instead of Cloudflare Access                       |
| Media processing        | Existing FFmpeg/libvips processor in a private container; no Docker socket                                       |
| TLS                     | Optional Caddy profile in the same Compose file                                                                  |

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

Open <http://localhost:8080/sign-in>. On an empty installation, enter the private
`AUTH_SETUP_SECRET` from `.env.selfhost`, your name, email, and a unique password
to create the installation's only owner. Follow the emailed verification link,
then sign in. Once the owner exists, registration closes, including direct API
requests. Development fixtures and passwords are not installed. PostgreSQL is
not published to the host. Only loopback application ports are published by default.

Set optional Provider/billing variables in `.env.selfhost` using the names in
[`.env.example`](../.env.example). Self-hosting does not bypass Provider live-mode
checks or account permissions. Do not change `ENVIRONMENT` to disable verification;
the supervisor deliberately retains deployed security behavior.

## Authentication and owner recovery

Each installation accepts one owner, without changing Workspace or Brand Profile
ownership. The database enforces the singleton even if two setup requests race.
Migration `010_single_owner_auth.sql` adopts a sole existing account; it refuses
to choose between multiple existing accounts. Back up and explicitly reconcile
authentication identities and their domain ownership before retrying that migration;
do not delete accounts blindly or reset production data to bypass the guard.
For local development databases seeded before this migration, use `make reset`
to recreate the disposable fixtures; never use it against production data.

`AUTH_SETUP_SECRET` must be a private, randomly generated value of at least 32
characters. Existing environment files must add it; the generator does not
overwrite them. It is an API-only bootstrap credential, never a browser build
variable. Setup status reveals only whether registration has closed. After setup,
the owner's password and optional second factor authenticate sign-in, not the
bootstrap secret.

Better Auth stores salted scrypt password hashes, not plaintext passwords.
Passwords are 8–128 characters; use a password manager and a unique passphrase.
No remote compromised-password screening or Turnstile service is configured:
password creation has no external screening dependency and does not reject a
reused password solely because it appeared in a breach. PostgreSQL-backed limits
bound credential attempts and verification/reset delivery across API instances;
client-supplied `X-Forwarded-For` cannot select a different budget.

Deployed sign-in requires verified email and configured mail delivery. Use
**Resend verification** on the sign-in form if needed, or **Forgot password?**
for a single-use, expiring reset link. Recovery responses do not disclose whether
an address is registered. Mailpit proves SMTP submission and link handling in CI,
not delivery to an external inbox.

Open **Account security** from desktop or mobile navigation to change the password
or configure an authenticator. Enrollment provides a manual setup key and backup
codes, then requires a live authenticator code before activation. Save backup
codes offline: each works once; generating replacements invalidates the old set.
Password reauthentication protects enrollment, replacement, and disabling the
factor. There is no trusted-device bypass. Password reset does not bypass 2FA;
if both the authenticator and backup codes are lost, privileged operator recovery
is required, not an email-only second-factor bypass.

Sign-out revokes the stored session. Protected API calls require a signed JWT
whose session is still live and belongs to the owner. Password changes, resets,
and factor activation/deactivation revoke existing sessions and pending factor
challenges. Regenerating backup codes retains the current session until the owner
saves them and signs out. Already committed durable work retains its original
authorization; signing out is not a cancellation of scheduled publishing.

Protect database backups and preserve `BETTER_AUTH_SECRET` and encryption keys:
factor material is encrypted, and replacing keys can make it unreadable.

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
