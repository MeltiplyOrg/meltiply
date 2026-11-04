# Production self-hosting

Meltiply supports two deployment targets: [managed Cloudflare staging/production](../infra/cloudflare/README.md#release-and-rollback)
and a single-host [Docker Compose deployment](../compose.selfhost.yml). Both run
production-built API, automation handlers, state coordinator, reply workflow,
and application frontend; neither replaces the development stack (`make dev`).
Managed Workers use their own protected release/backend and Cloudflare services.
This guide instead describes Compose's separate `ENVIRONMENT=selfhost` runtime,
local binding persistence, and SMTP; it does not deploy a managed staging stack.

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
| Email                   | Optional real SMTP transport; verification follows the mail configuration described below                         |
| Operator authentication | Private administrator-issued HMAC tokens, at most 15 minutes, instead of Cloudflare Access                        |
| Media processing        | Existing FFmpeg/libvips processor in a private container; no Docker socket                                        |
| TLS                     | Optional Caddy profile in the same Compose file                                                                   |

This is a **single-host** deployment, not a replacement for Cloudflare's global
network, managed durability, autoscaling, Access, or service SLAs. Run one runtime
replica per data volume; do not share its SQLite files across hosts. Back up both
the PostgreSQL and runtime state. Social Providers remain external services and
require your own credentials, public callback URLs, and approvals. Both targets
may start with all Provider acceptance flags false; connections and publishing
then remain unavailable until the relevant live acceptance is established.
No Cloudflare account, Email Sending domain, or remote Workers are required by
this Compose target.

The API uses bounded, disposable Worker-local memory for read optimization, with
the same implementation on managed Workers and self-hosted workerd. Publishing
requirements share only overlapping equivalent Provider reads, after every caller's
fresh account/credential checks; completed results are not retained. At most 32
pending keys are retained; additional distinct reads bypass coalescing. Analytics
`GET /api/v1/analytics` summaries retain successful values for an absolute 30 seconds,
at most 64 entries of 16 KiB each (1 MiB serialized payload, plus keys/bookkeeping).
Every request still establishes current authorization and active Brand Profile
lifecycle visibility under PostgreSQL RLS. Snapshot/publication changes can remain
invisible until expiry; deletion/restoration and access changes are checked on
each request. The dashboard endpoint is not cached by this optimization.

These caches are neither durable nor shared across isolates or runtime replicas.
Restart, eviction, capacity bypass, and configuration replacement fall back to
authoritative reads. No Redis, Valkey, KV, new binding, backup, or operator cache
configuration is required.

## Browser reads and private freshness

The signed-in app keeps API responses only in an in-memory TanStack QueryClient
scoped to the current user and Workspace. Identity or Workspace changes clear
that client's private entries; reloads start cold. Private responses are not
written to browser storage or shared CDN caches.

| Read                                          | Freshness before another request | Inactive in-memory retention |
| --------------------------------------------- | -------------------------------- | ---------------------------- |
| Analytics, active Brand Profiles and Channels | 5 minutes                        | 30 minutes                   |
| Posts                                         | 1 minute                         | 30 minutes                   |
| Provider capabilities                         | Current signed-in QueryClient    | Until that client is cleared |

Your own supported mutations update or invalidate the affected cache immediately.
Analytics Refresh advances its shared dashboard/ranking cohort. Other members'
changes may remain unseen until freshness expires or you refresh. These browser
rules do not replace live server authorization: sessions, suspension, current
Workspace membership, role and profile visibility are checked on each API read.

Active Post and Calendar work refreshes at most four detail reads concurrently
per loaded collection every ten seconds. Future scheduled work starts polling only
when due. Settled rows do not poll, and updated details do not refetch every loaded
collection page. This is progress discovery, not a scheduling deadline guarantee.
Managed API and Automation drivers close PostgreSQL clients at operation release;
Hyperdrive alone retains origin connections. The operator must not disable origin
pooling to compensate for invocation-scoped driver ownership.

## Managed Worker operations

The two-minute media-container idle timeout applies only after a Worker Durable
Object/RPC request completes, never in the middle of a media job. Container
restarts lose engine memory; the persisted job identity and idempotent stored
output, not an in-memory engine cache, govern replay.

Recurring Comment-body collection defaults off because there is no in-app Inbox.
The managed Automation Worker accepts `RECURRING_COMMENTS_ENABLED=true` to opt in
after an authorized operational need exists. Default-off deployments still retain
historical Comments, numerical Analytics, authorized on-demand fetching and
their durable retry/cursor recovery. This flag does not expose an Inbox or grant
additional member access.

Publishing Queues remain capped at one consumer invocation. The serial batch
default (`PUBLISH_BATCH_CONCURRENCY=1`) may be changed to `2` to overlap two
different Provider accounts only; one account remains ordered. Use the hosted
capacity acceptance measurement and verify the account's actual Provider rate
budget before enabling it. This bounded mode is not a cross-invocation lock.

Automation scheduled recovery performs Due publishing, Outbox relay and
Distribution reconciliation before account analytics. Application success logs
and traces are sampled at 10%, but platform logs/invocation logs remain unsampled
so failures are not discarded by the application sampling rate. Audit and durable
job/outbox records are unchanged.

## First start from source

Requirements: Docker Engine with a recent Docker Compose v2 supporting inline
`configs.content`, and Node 24 for the configuration generator. Images support
Linux amd64 and ARM64, with native CI builds and complete Compose smoke checks on
both architectures; no emulation is required. SMTP is optional; without it the
installation disables email verification.

From the repository root:

```bash
node scripts/selfhost/configure.mjs
# Edit .env.selfhost if you want email delivery and verification:
#   MAIL_FROM_ADDRESS=no-reply@example.com
#   SELFHOST_SMTP_URL=smtps://user:pass@mail.example.com:465
docker compose --env-file .env.selfhost -f compose.selfhost.yml build
docker compose --env-file .env.selfhost -f compose.selfhost.yml up -d --wait
```

The generator records the native architecture as `SELFHOST_PLATFORM=linux/amd64` or
`linux/arm64`. Both are release targets with native CI builds; 32-bit ARM is not.
Existing environment files must add the setting explicitly. It writes private random credentials to
`.env.selfhost` with mode 0600 and refuses to overwrite an existing file. Keep that
file out of version control, in backups readable only by administrators.

`APP_URL` is the single public dashboard/API origin. It defaults to
`http://localhost:8080`; set your public HTTPS origin when exposing the installation.
Authentication, OAuth callbacks and return links, signed media URLs, browser API
requests, and the optional TLS gateway all use it. There is no separate API or
authentication URL.
Mail is optional. When `MAIL_FROM_ADDRESS` and `SELFHOST_SMTP_URL` are both set,
startup verifies the SMTP connection and email verification remains required. Use
an authenticated `smtps://` URL or a properly configured STARTTLS SMTP server;
URL-encode credential characters. When both are empty, verification is disabled
and owner setup signs in immediately. Set `SELFHOST_REQUIRE_EMAIL_VERIFICATION=true`
to require verification explicitly; doing so requires working SMTP settings.
The `verification` profile contains a capture-only Mailpit service for CI,
**not email delivery**.

Open <http://localhost:8080/sign-in>. On an empty installation, the first-run
setup screen asks for the private `AUTH_SETUP_SECRET` from `.env.selfhost`, your
name, email, a unique password, and the shared Workspace name. With SMTP
configured, follow the emailed verification link, then sign in; without SMTP,
setup completes without a verification step. The next screen offers the optional
discovery-source question and the two independently off improvement-reporting
choices, each of which can be skipped. Once the owner exists, registration closes,
including direct API requests. Development fixtures and passwords are not
installed. PostgreSQL is not published to the host. Only loopback application
ports are published by default.

Set optional Provider/billing variables in `.env.selfhost` using the names in
[`.env.example`](../.env.example). Self-hosting does not bypass Provider live-mode
checks or account permissions. Do not change `ENVIRONMENT` to control verification;
use `SELFHOST_REQUIRE_EMAIL_VERIFICATION` instead.

## Improvement reporting

Optional usage statistics and diagnostic reports are controlled by the Installation
Owner in Settings and start off. The released runtime image carries the maintainer's
publishable PostHog Cloud project token and matching ingestion origin, so you need no
PostHog account and no extra configuration to let the Owner contribute.

Nothing is sent while a destination is unconfigured or the Owner has not opted in:
readiness and publishing never depend on it, and the settings screen reports the
destination as unavailable rather than pretending reporting works. Set
`REPORTING_FORCED_OFF=true` in `.env.selfhost` to disable both categories installation-wide,
or set your own `REPORTING_POSTHOG_PROJECT_TOKEN` and `REPORTING_POSTHOG_HOST` to point
at a project you control. An empty value in `.env.selfhost` with no image default keeps
reporting off.

Reports are bounded aggregates and sanitized application exceptions. Channels appear
only as per-Platform counts; content, member identities, Workspace names, Post text,
Assets, and credentials are never included, and no person profile, autocapture, pageview,
session replay, or GeoIP enrichment is used. The reports still carry a random installation
identifier and are therefore pseudonymous rather than anonymous, and the vendor ingress
still sees the runtime's outbound address. What is collected, the dashboard setup, and
the retention and deletion facts are in
[improvement reporting operations](improvement-reporting.md).

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
supervisor runs as `ENVIRONMENT=selfhost`, whose storage policy also rejects
plain-HTTP signing origins. `S3_FORCE_PATH_STYLE` defaults to `true`, which is what
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
Configure bucket CORS to allow browser GETs and PUTs from the application origin,
including `content-type` and the signed headers, and expose `ETag` for multipart
uploads. GET allows signed original-media reads when copying a composition's
attachments into another Brand Profile.
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

## Authentication, invitations, and owner recovery

The first bootstrapped account becomes the Installation Owner and creates the
single shared Workspace. The Owner and Workspace Admins invite people by email;
public registration then stays closed, including direct API requests. Invitations
are bound to the invited address, expire after seven days, and require email
verification before membership activates. Each installation supports at most ten
people, counting active members and pending invitations; suspension or revocation
frees a Seat.

The Owner controls installation-level actions: suspending, reactivating, and
hard-deleting accounts, and transferring ownership after reauthentication.
Workspace Admins manage Editors and Viewers, Brand Profiles, Channels, the
Workspace name, and the audit trail. Editors create and publish content; Viewers
read Posts, Channels, and analytics.

`AUTH_SETUP_SECRET` must be a private, randomly generated value of at least 32
characters. Existing environment files must add it; the generator does not
overwrite them. It is an API-only bootstrap credential, never a browser build
variable. Setup status reveals only whether the installation has an Owner.

The first sign-up may carry the shared Workspace name as `workspace_name`. It is
recorded before the account is created and promoted to the bootstrap record when
the account exists, so a failed verification mail or an interrupted invocation
cannot lose the choice; the name is applied once, when that sign-up's first
authenticated request creates the Workspace. Omitting it keeps the derived
`<display name>'s workspace` default. The Owner's `/api/v1/onboarding` read, save,
and complete operations carry that journey's progress and are
Installation-Owner-only; the reached optional screen is stored with it, so a
restart resumes there rather than restarting the step. An installation that
already has an Owner and Workspace without a bootstrap record reports
`not_applicable`: its Owner signs in normally and is never pushed back through
setup. Completion never renames the Workspace, so a later Settings rename stands.

An installation that upgrades to a release with improvement reporting keeps both
categories off until its Owner decides in Settings; nothing is enrolled silently.
Improvement reporting choices are installation-level, so they do not grant
permission to record every member: the [privacy policy](../frontend/public/content/docs/privacy.mdx)
states the member-facing boundary, and no cross-device member tracking is added.

JWT issuer and audience use `APP_URL`. By default the API retrieves signing keys
from that origin's `/api/auth/jwks`. If browser-only ingress authentication protects the public host,
set `BETTER_AUTH_JWKS_URL` to a trusted internal endpoint for the same installation;
this changes only key retrieval, not issuer, audience, or live-session validation.
The local development launchers automatically use loopback on their selected API
port, so Cloudflare Access on a dev tunnel cannot block signing-key retrieval.

Better Auth stores salted scrypt password hashes, not plaintext passwords.
Passwords are 8–128 characters; use a password manager and a unique passphrase.
No remote compromised-password screening or Turnstile service is configured:
password creation has no external screening dependency and does not reject a
reused password solely because it appeared in a breach. PostgreSQL-backed limits
bound credential attempts and verification/reset delivery across API instances;
client-supplied `X-Forwarded-For` cannot select a different budget.

Managed staging/production sign-in always requires verified email and Cloudflare
Email Sending. Compose self-hosting instead follows its optional SMTP/verification
settings above. With mail configured, use **Resend verification** on the sign-in
form if needed, or **Forgot password?** for a single-use, expiring reset link.
Recovery responses do not disclose whether an address is registered. Mailpit
proves SMTP submission and link handling in CI, not delivery to an external inbox.

Open **Settings → Security** on desktop or mobile to see password and authenticator
controls directly. Enrollment provides a manual setup key and backup
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

`melti-cli` uses the same origin, sign-in, second-factor, suspension, and session
policy through the [CLI device authorization protocol](device-authorization.md).
Approval creates a separate revocable CLI session; no password or browser JWT is
copied into the terminal.

Protect database backups and preserve `BETTER_AUTH_SECRET` and encryption keys:
factor material is encrypted, and replacing keys can make it unreadable.

## HTTPS and public callbacks

Point the app's DNS name at the host, allow TCP 80/443 and optionally UDP 443, and add:

```dotenv
APP_URL=https://app.example.com
```

Then start the same file with its TLS profile:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.yml --profile tls up -d --wait
```

Caddy derives its certificate hostname from `APP_URL` and forwards the app. Its origin must match the
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

# Break-glass: promote an existing account to Installation Owner. Use this only
# when the Owner session and recovery path are lost; the target must already have
# an account. It also restores that account to Workspace Admin, clears any
# suspension so the new Owner can authenticate, and records the ownership,
# membership, and reactivation changes in the Workspace Audit trail.
docker compose --env-file .env.selfhost -f compose.selfhost.yml exec -T runtime \
  node scripts/selfhost/admin.mjs promote-owner owner@example.com
```

Managed deployments use the same action through the operator runbook: an
on-call operator with privileged access promotes the existing account, records
the incident, and asks the new Owner to rotate credentials. Ownership transfer
inside the product remains the normal path.

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

The self-host acceptance suite restores a full disposable clone — PostgreSQL dump,
stopped `/data` volume, matching image revision, and protected environment — before
running identity, R2, OAuth, Queue, and Workflow probes. Stop writes for consistency,
and preserve the encryption keys and the exact application revision.

The CI fixture records one sample per architecture in
`artifacts/cache/compose-<arch>-restore.json`. Those measurements cover a tiny
disposable database and explicitly record `production_rpo_rto_verified: false`; they
are not production RPO or RTO. Take a timed restore on your own infrastructure.

The migration ledger is append-only. Do not rename entries to bypass checksum or
ordering checks: a skipped entry leaves its migration unapplied. Pre-release
development databases may carry an incompatible ledger; back up before recreating
one, and use a reviewed data migration for any non-disposable database.
