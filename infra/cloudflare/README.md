# Cloudflare infrastructure

This OpenTofu root manages either `staging` or `production` account/zone resources.
They are separate installations, with separate protected inputs and state. No
other environment or preview stack is supported. Worker code and version
deployment remain Wrangler-owned; use the release CLI rather than deploying
checked-in placeholder configs directly. This runbook describes operator actions,
not evidence that a live Cloudflare or Neon deployment has been performed.

## Ownership

| Owner               | Resources                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenTofu            | API domain, WAF/rate controls, private R2 bucket/CORS/lifecycle/events, Queues and DLQs, consumer retry/concurrency, Access, and release outputs |
| Wrangler            | Worker source/versions, compatibility/CPU settings, bindings, handler declarations, and Durable Object migrations                                |
| Protected bootstrap | Two distinct Hyperdrive configurations, validated by OpenTofu with query caching disabled                                                        |

Managed Queue consumers are OpenTofu-owned; the Automation Wrangler config
intentionally omits them. Local Wrangler declares consumers because workerd has
no Cloudflare control plane. See [main.tf](main.tf), [variables.tf](variables.tf),
and [outputs.tf](outputs.tf) for the resource graph and release controls.

The safe default pauses delivery and attaches neither consumers nor custom
domains. Each Provider has a separate publish Queue and DLQ. DLQs are pull-only
quarantine: replay requires an explicit operator action.

## Plan and validate

Run from the repository root:

```bash
bun run iac:check
```

This checks formatting, backend-free initialization, provider signatures,
validation, mocked plans, policy, and cost inputs. Tool/provider versions belong
in the [installer](../../scripts/infra/install-opentofu.sh) and
[lockfile](.terraform.lock.hcl), not a second version inventory here.

For an authenticated plan, select the installation explicitly:

```bash
.bin/tofu -chdir=infra/cloudflare init \
  -reconfigure \
  -backend-config=/protected/meltiply/production/backend.hcl
MELTIPLY_IAC_TFVARS=/protected/meltiply/production/foundation.tfvars bun run iac:check
```

Use [backend.hcl.example](backend.hcl.example) and either
[staging.tfvars.example](staging.tfvars.example) or
[production.tfvars.example](production.tfvars.example) as templates. For staging,
use `/protected/meltiply/staging/` instead, with its own state addresses, not a
second filename pointing at production state.
Supply credentials through `TF_HTTP_USERNAME`/`TF_HTTP_PASSWORD`. The state service must
provide TLS, encryption at rest, access control, backups, and locking. Keep
populated backend files, state, plans, and plan JSON out of version control.
Apply only an approved plan with real resource IDs, a protected backend,
a least-privilege token, and a release record.

### Secrets and permissions

Database passwords, Provider credentials, authentication secrets, and encryption
keys stay outside HCL and state. `bun run hyperdrive:bootstrap` creates or rotates
the two configurations through the API; only their non-secret IDs enter OpenTofu
and Worker bindings. Ambiguous names fail closed; a partial failure returns the
completed ID for recovery. See [the bootstrap implementation](../../scripts/infra/hyperdrive-bootstrap.mjs).

Before bootstrap or online preflight, provision the database roles described in
[database provisioning](#database-provisioning). Bootstrap, online preflight, and
migrations verify both role definitions through both protected login connections.
Offline preflight reports `database_roles.status=skipped` with reason `offline`;
it proves neither database readiness nor account/product access.

Use separate account-scoped identities for Hyperdrive bootstrap, infrastructure
planning/apply, Worker deployment, and protected secret injection. Grant only
the required resource permissions; keep the secret-writing capability confined
to the injection step.

The API secret bundle requires `AUTH_SETUP_SECRET` (random, at least 32 characters)
alongside `BETTER_AUTH_SECRET`, encryption keys, and the existing mail configuration.
First-run owner setup at `/sign-in` requires that secret; registration closes
once the sole owner exists. Deployed email verification is not optional.
See [authentication, invitations, and owner recovery](../../docs/self-hosting.md#authentication-invitations-and-owner-recovery)
for migration, password, and authenticator policies. Managed Workers trust
Cloudflare's `CF-Connecting-IP` for shared rate limits, not caller-supplied
`X-Forwarded-For`; the self-hosted ingress instead uses its socket peer.

## Object storage selection

Releases default to the IaC-managed R2 bucket. To select an S3-compatible service,
add these non-secret settings to `runtime` in the release input:

```json
{
  "object_storage_provider": "s3",
  "s3_bucket": "meltiply-assets",
  "s3_endpoint": "https://objects.example.com",
  "s3_region": "us-east-1",
  "s3_force_path_style": true
}
```

Region and addressing style are optional with the defaults shown above. The
endpoint must be an origin-only HTTPS URL. Keep `runtime.r2_account_id`: despite
its historical name, it identifies the Cloudflare account for Worker and Cron
administration even when assets live elsewhere.

The renderer applies the same provider settings to API and Automation and omits
their unused `ASSETS` bindings for S3. Protected secret injection then requires
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` on both Workers instead of the R2
credentials. Never put either credential in the release input or Wrangler vars.
The infrastructure foundation still provisions its R2 bucket; selecting S3
does not destroy that bucket or copy its data.

See [object storage requirements](../../docs/self-hosting.md#object-storage)
for conditional operations, browser CORS, and provider cutover requirements.
The default R2 bucket's CORS rule permits GET for signed original-media reads and
PUT for direct browser uploads, restricted to the configured application origins.

## Release and rollback

The canonical flow below applies to both supported managed environments. A
first deployment uses `deployment_mode: "bootstrap"`; an existing installation
uses `update` and the [update differences](#updating-an-existing-installation).
Queue delivery stays paused through domain attachment and live smoke. Cron
activation is separately verified after the approved Queue resume. Worker rollback
changes routing/code, not PostgreSQL, R2, Queue, Workflow, or Durable Object state.
Pause producers and consumers and use forward storage fixes.

### Account and workstation prerequisites

Arrange these before planning; scripts cannot provision account eligibility or
complete third-party review:

- A Cloudflare account on **Workers Paid**, with Queues, R2, Hyperdrive, Workflows,
  Durable Objects, and Containers available. The Automation deployment builds its
  media processor container; have a working Docker engine and registry/deployment
  permissions as well as the repository's pinned Node/Bun/OpenTofu tools.
- A Cloudflare-managed DNS zone for the HTTPS application hostname and, if
  enabled, a distinct operator hostname and configured Cloudflare Access team.
  Reserve names before attaching custom domains; do not point the app hostname
  directly at the API Worker.
- A fresh Neon PostgreSQL branch/database per installation, its direct TLS compute
  endpoint, an administrator able to provision the required role attributes,
  and a Neon API key permitted to create/read branch snapshots. Confirm snapshot
  retention and budget support the required 7–30-day restore-point lifetime.
- An R2 S3 API access key pair scoped to the selected environment's asset bucket
  (or the [explicit S3 alternative](#object-storage-selection)). Arrange credentials
  for the bucket planned by IaC and finish bucket scoping after foundation apply.
  These are not the Cloudflare control-plane API token.
- **Cloudflare Email Sending** onboarding, an authorized sending domain with its
  required DNS records verified, and a sender matching `runtime.mail_from_address`.
  The rendered API `MAIL` binding restricts `allowed_sender_addresses` to that
  address. See [Email Sending setup](https://developers.cloudflare.com/email-service/)
  for current account eligibility and domain onboarding. There is no SMTP/API-key
  fallback for managed Workers. Email verification is mandatory for staging and
  production; verify actual inbox delivery before inviting members.
- For each enabled Platform: your own Provider app, client credentials, HTTPS
  OAuth callback and any webhook/media URL registration, necessary account roles,
  scopes, consent, app review and production access. See the
  [Provider connection research](../../docs/research/provider-channel-connections.md).
  Facebook/Instagram/Threads, TikTok, and YouTube permissions and reviews remain
  external obligations; a successful deployment never grants them.

All `provider_acceptance` flags may remain `false` for installation verification
before app review. The capability/readiness responses then report Platform
connections and publishing unavailable; the Channels surface follows that
readiness. This is a working installation with disabled external capabilities,
not live Provider acceptance. Set a flag true only after separately recording
the relevant real-account acceptance and providing its required non-secret client
ID in `runtime` and client secret in both Worker secret bundles. Engagement flags
are separate from publishing acceptance. Do not set flags merely to make a
capability appear available.

Use separate least-privilege identities for infrastructure, Hyperdrive bootstrap,
Worker deployment, secret injection, and monitoring. Load credentials from your
protected environment; do not paste them into shell history or evidence. Required
operator variables are:

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Selected account and step-specific control-plane permissions; account ID must match `runtime.r2_account_id` |
| `TF_HTTP_USERNAME`, `TF_HTTP_PASSWORD` | Selected installation's protected locking state service |
| `MELTIPLY_SYSTEM_DATABASE_URL` | TLS Neon URL logging in directly as `meltiply_system` |
| `MELTIPLY_AUTHENTICATED_DATABASE_URL` | Same endpoint/database, logging in directly as `meltiply_rls` |
| `NEON_API_KEY`, `MELTIPLY_NEON_PROJECT_ID`, `MELTIPLY_NEON_BRANCH_ID` | Snapshot creation; IDs must match the release input |

Online preflight validates credentials' presence/account selection and queries
the database roles; it is not a blanket API permission or Email Sending delivery
test. Restore points, deployments, and smoke provide their own later evidence.

### Database provisioning

Provision roles **before any migration**, on the selected empty database:

1. In the [Neon Console](https://console.neon.tech), select the exact project and
   branch, then **Postgres database → Roles → Add role**. Create a new
   `meltiply_system` and save its generated password privately. Neon control-plane
   role creation sets `BYPASSRLS` on the role itself; it is not just inherited
   membership. Do not first create this role through SQL and expect a later
   password reset to promote its attributes.
2. Connect as the branch's administrator to the selected database with the SQL
   Editor or a protected `psql` session. Create the **restricted** role through SQL
   and grant the migration login database/schema creation rights:

```sql
CREATE ROLE meltiply_rls LOGIN PASSWORD '<unique-authenticated-password>'
  NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE "<selected-database>" TO meltiply_system, meltiply_rls;
GRANT CREATE ON DATABASE "<selected-database>" TO meltiply_system;
GRANT USAGE, CREATE ON SCHEMA public TO meltiply_system;
```

`CREATE` on the database allows the migration-owned `auth` schema to be created;
the migration runner connects as `meltiply_system` and owns the objects it creates.
Existing migrations install the tenant grants/policies for `meltiply_rls`; do not
grant it administrative membership or bypass rights. Substitute the database
identifier and unique password privately, never in the repository or a recorded
terminal. Inspect the resulting role attributes:

```sql
SELECT rolname, rolcanlogin, rolbypassrls, rolsuper
FROM pg_catalog.pg_roles
WHERE rolname IN ('meltiply_system', 'meltiply_rls');
```

Require `meltiply_system` to have `rolcanlogin=true`, `rolbypassrls=true`, and
`meltiply_rls` to have `rolcanlogin=true`, `rolbypassrls=false`, `rolsuper=false`.
Never create `meltiply_rls` through the Console/API/CLI: those interfaces give
administrator privileges. If a role already exists with incorrect attributes,
stop and correct its provisioning before continuing. In particular, do not
assume an ordinary Neon SQL administrator can issue `CREATE ROLE ... BYPASSRLS`
or `ALTER ROLE ... BYPASSRLS`.

For clarity, these are the equivalent SQL role declarations **for an administrator
with permission to set these attributes**, not commands to run instead of the
Neon control-plane step above:

```sql
CREATE ROLE meltiply_system LOGIN PASSWORD '<unique-system-password>'
  NOSUPERUSER BYPASSRLS;
CREATE ROLE meltiply_rls LOGIN PASSWORD '<unique-authenticated-password>'
  NOSUPERUSER NOBYPASSRLS;
```

The managed distinction is documented in
[Neon's role interfaces](https://neon.com/docs/manage/roles) and
[RLS connection guide](https://neon.com/docs/guides/rls-query-execution);
its [role creation implementation](https://github.com/neondatabase/neon/blob/main/compute_tools/src/spec_apply.rs)
explicitly sets `BYPASSRLS` for new ordinary control-plane roles. The release
requires that actual attribute, not a renamed owner or an assumed `SET ROLE`
session. Both protected URLs must use their named role as `current_user` and
`session_user`, target the same database/endpoint, and include `sslmode=require`,
`verify-ca`, or `verify-full`. Run online preflight below to verify both logins;
these provisioning instructions are not a claim of live Neon verification.

Bootstrap, online preflight, and migration share the same role assertion. Missing
or wrong roles stop migrations **before** advisory locking, transactions, or
ledger writes. After migration, the runner requires the `auth` schema,
`auth.jwt()` claims accessor, and enabled tenant RLS policies for `meltiply_rls`.

If an earlier run already recorded the baseline while RLS setup was skipped,
creating roles and rerunning cannot repair that ledger. **Recreate the affected
Neon branch from a clean, unmigrated source**, then provision roles and start a new
release session. Preserve any required data first; do not delete a non-disposable
installation's branch without an approved recovery/data-migration procedure.
Do not edit existing migration files or remove ledger rows to force replay.

### Select and protect one installation

No CI account is required for deployment. On a trusted workstation, use a clean
checkout of the exact commit and a new ignored `.release` directory. Populate a
protected copy of
[`release-input.example.json`](../../scripts/release/release-input.example.json)
and the environment's tfvars template. In a Bash session from the repository root:

```bash
umask 077
export MELTIPLY_ENVIRONMENT=production # Use staging for the staging installation.
protected="/protected/meltiply/$MELTIPLY_ENVIRONMENT"
export MELTIPLY_RELEASE_SHA="$(git rev-parse HEAD)"
export MELTIPLY_RELEASE_INPUT="$protected/release.json"
export MELTIPLY_TF_BACKEND_CONFIG="$protected/backend.hcl"
export MELTIPLY_RELEASE_DIR="$PWD/.release/$MELTIPLY_ENVIRONMENT-${MELTIPLY_RELEASE_SHA:0:12}"
export MELTIPLY_RELEASE_IAC_OUTPUTS="$MELTIPLY_RELEASE_DIR/iac-outputs.json"
```

`protected` and the arrays below are local Bash conveniences, not additional CLI
settings. Set the input's `environment` to the selection, `deployment_mode` to
`bootstrap`, `git_sha` to the full SHA, and `release_id` to
`<environment>-<first-12-SHA-characters>`. Set your actual Neon IDs, a future
7–30-day `restore_point_expires_at`, sender, account ID, and HTTPS `app_url`.
`api_workers_dev_url` is the selected API Worker's account workers.dev origin
(including `-production` for the production API), used for version-preview smoke;
the stable workers.dev route remains disabled.

Use one matching `app_url` in release input and every phase's tfvars. IaC derives
the app hostname and R2 CORS origin; optional `allowed_origins` are additive.
Keep **each environment's own** backend configuration, release JSON, phase tfvars,
database/Hyperdrive IDs, credentials, and release directories. In particular,
all three backend `address`, `lock_address`, and `unlock_address` values must
address that installation's state, with TLS, locking, backups, access controls,
and encryption at rest. Merely renaming a backend file does not isolate state.
Never initialize production against staging state or use state migration to switch
environments. The wrapper reconfigures the explicit backend every time and binds
its bytes/path and the protected input to the session before contacting OpenTofu.

Create complete protected tfvars files with identical installation settings and
only these reviewed activation differences:

| File under `$protected` | `attach_queue_consumers` | `attach_app_custom_domains` | `queue_delivery_paused` |
| --- | --- | --- | --- |
| `foundation.tfvars` | `false` | `false` | `true` |
| `paused-consumers.tfvars` | `true` | `false` | `true` |
| `domain.tfvars` | `true` | `true` | `true` |
| `unpause.tfvars` | `true` | `true` | `false` |
| `pause.tfvars` (updates only) | `true` | `true` | `true` |

Review the names that `release_resources` will output:

| Service/resource | Existing staging name | Production name |
| --- | --- | --- |
| API | `meltiply-api` | `meltiply-api-production` |
| Automation | `meltiply-automation` | `meltiply-automation-production` |
| State | `meltiply-state` | `meltiply-state-production` |
| Frontend | `meltiply-frontend-staging` | `meltiply-frontend-production` |
| Asset bucket | `meltiply-assets-staging` | `meltiply-assets-production` |
| Workload Queue / DLQ | `meltiply-<workload>-staging` / `meltiply-<workload>-staging-dlq` | `meltiply-<workload>-production` / `meltiply-<workload>-production-dlq` |

Staging's existing unsuffixed backend services remain unchanged; do not rename
them during an update. Production's services, container and Durable Object
namespaces are isolated from staging. The frontend name is reviewed via
`frontend_worker_name`; its `API` service binding targets `worker_names.api`
from the same outputs. The app hostname serves frontend assets and forwards
`/api/*` to that API; an enabled operator hostname attaches to the API.

### Bootstrap Hyperdrive and paused foundation

With the selected account's Hyperdrive bootstrap credentials and both database
URLs loaded:

```bash
bun run release:preflight:offline
bun run release:preflight
bun run hyperdrive:bootstrap
```

Save the returned **distinct** authenticated/system Hyperdrive IDs to every
protected phase tfvars file before planning. Query caching is disabled. On
rotation/recovery, supply `MELTIPLY_AUTHENTICATED_HYPERDRIVE_ID` and
`MELTIPLY_SYSTEM_HYPERDRIVE_ID` for the existing selected configurations; ambiguous
names fail closed and partial failure reports the completed ID. Do not change the
release input or backend after the first plan binds the session.

Plan, inspect both the raw plan and policy summary, and attest to the exact bytes:

```bash
./scripts/infra/release-transition.sh plan foundation "$protected/foundation.tfvars"
.bin/tofu -chdir=infra/cloudflare show "$MELTIPLY_RELEASE_DIR/foundation.tfplan"
cat "$MELTIPLY_RELEASE_DIR/foundation-plan-summary.json"
foundation_digest="$(cat "$MELTIPLY_RELEASE_DIR/foundation-plan.sha256")"
bun run release:approve foundation "$MELTIPLY_RELEASE_INPUT" \
  "$MELTIPLY_RELEASE_DIR/foundation.tfplan" "$USER" \
  "approve $MELTIPLY_ENVIRONMENT $MELTIPLY_RELEASE_SHA $foundation_digest"
MELTIPLY_RELEASE_CONFIRM="apply $MELTIPLY_ENVIRONMENT foundation $MELTIPLY_RELEASE_SHA $foundation_digest" \
  ./scripts/infra/release-transition.sh apply foundation
bun run release:render

foundation_flags=(--apply --confirm "release $MELTIPLY_ENVIRONMENT $MELTIPLY_RELEASE_SHA" \
  --plan-digest "$foundation_digest" \
  --approval-metadata "$MELTIPLY_RELEASE_DIR/approval-foundation.json")
```

Use the appropriate step-specific token for each operation. Review receipts are
local intent records, not authenticated signatures; protected filesystem access
and deployment credentials are the trust boundary. Create receipts **before**
apply deletes sensitive raw plan/JSON. The wrapper checks checkout, phase,
environment, commit, input/backend context and plan digest, then saves phase-specific
and current `iac-outputs.json`. Never apply untrusted contributor-produced plans,
reuse a directory for another release, or hand-edit outputs/evidence.

### Restore point, migrations, State and Automation

```bash
bun run release:restore-point "${foundation_flags[@]}"
bun run release:migrate --phase bootstrap "${foundation_flags[@]}"
bun run release:cron --phase cron-pause "${foundation_flags[@]}"
bun run release:deploy --phase state-bootstrap --step initialize "${foundation_flags[@]}"
bun run release:deploy --phase automation-bootstrap --step initialize "${foundation_flags[@]}"
```

The restore point is a real Neon branch snapshot checked against the reviewed
project/branch and endpoint, not a declaration that backups exist. Preserve its
evidence and expiry. Migration evidence records checksums and installed RLS.
Bootstrap `cron-pause` verifies an empty schedule set (a not-yet-created Automation
Worker is allowed); Automation initializes without triggers. State initializes
directly at 100% and needs no release secrets.

Prepare `$protected/secrets.json`, or pipe the same JSON from your secret manager.
The CLI accepts non-interactive stdin only, at most 64 KiB, and requires **both**
top-level `api` and `automation` objects with exactly the required keys. For
default R2 storage and all acceptance flags false the shape is:

```json
{
  "api": {
    "AUTH_SETUP_SECRET": "<random-bootstrap-secret-at-least-32-characters>",
    "BETTER_AUTH_SECRET": "<random-session-secret-at-least-32-characters>",
    "R2_ACCESS_KEY_ID": "<selected-bucket-access-key>",
    "R2_SECRET_ACCESS_KEY": "<selected-bucket-secret-key>",
    "TOKEN_ENCRYPTION_KEY": "<base64-encoded-32-byte-key>"
  },
  "automation": {
    "R2_ACCESS_KEY_ID": "<same-selected-bucket-access-key>",
    "R2_SECRET_ACCESS_KEY": "<same-selected-bucket-secret-key>",
    "TOKEN_ENCRYPTION_KEY": "<same-base64-encoded-32-byte-key>"
  }
}
```

Replace every placeholder privately. For S3, replace the two R2 keys in **both**
objects with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Enabled Provider flags
require their matching client secret in both objects as defined by the
[release secret contract](../../scripts/release/release-lib.mjs); extra keys fail.
No database URL or mail API key belongs in this bundle. Keep the bundle outside
the release directory and version control. Give only the secret injection
identity the secret-writing capability, then return to deployment credentials:

```bash
bun run release:secrets --phase automation "${foundation_flags[@]}" < "$protected/secrets.json"
bun run release:deploy --phase automation-bootstrap --step activate "${foundation_flags[@]}"
```

Initialization records a code candidate; secret injection creates a separate
secret-bearing version. **Activation must follow injection**, not the reverse.
Automation remains triggerless and Queue delivery paused.

### Attach paused consumers; deploy API and frontend

```bash
./scripts/infra/release-transition.sh plan paused-consumers "$protected/paused-consumers.tfvars"
.bin/tofu -chdir=infra/cloudflare show "$MELTIPLY_RELEASE_DIR/paused-consumers.tfplan"
cat "$MELTIPLY_RELEASE_DIR/paused-consumers-plan-summary.json"
consumers_digest="$(cat "$MELTIPLY_RELEASE_DIR/paused-consumers-plan.sha256")"
MELTIPLY_RELEASE_CONFIRM="apply $MELTIPLY_ENVIRONMENT paused-consumers $MELTIPLY_RELEASE_SHA $consumers_digest" \
  ./scripts/infra/release-transition.sh apply paused-consumers
bun run release:render

bun run release:deploy --phase api-bootstrap --step initialize "${foundation_flags[@]}"
bun run release:secrets --phase api "${foundation_flags[@]}" < "$protected/secrets.json"
bun run release:deploy --phase api-bootstrap --step activate "${foundation_flags[@]}"
bun run release:deploy --phase frontend-bootstrap --step initialize "${foundation_flags[@]}"
bun run release:smoke --phase version
```

`paused-consumers` permits only consumer attachment, still with delivery paused;
it does not have a separate approval scope. Keep using the foundation receipt
and digest for Worker/migration/secret operations.

Frontend initialization builds `build:staging` or `build:production` through the
CLI's reviewed Vite/Wrangler config and deploys the production bundle, not a dev
server. It records `worker-frontend-candidate.json` and
`worker-frontend-deployment.json`, including the reviewed name, source/built config
digests and 100% version traffic. Frontend needs neither secret injection nor a
separate bootstrap activate step. Repeating the step recovers this release's
tagged version instead of blindly redeploying.

Preserve private `wrangler/frontend.json` and `wrangler/frontend-built.json`.
The generated deployment config points at `frontend/app/dist` outside the evidence
directory; keep that build intact for deployment/recovery. Do not regenerate
configs with different inputs mid-release. Version smoke checks the API's
secret-bearing candidate, release SHA and selected environment before domains
are attached; it is not a frontend browser journey or external Provider test.

### Domain attachment and live smoke

```bash
./scripts/infra/release-transition.sh plan domain "$protected/domain.tfvars"
.bin/tofu -chdir=infra/cloudflare show "$MELTIPLY_RELEASE_DIR/domain.tfplan"
cat "$MELTIPLY_RELEASE_DIR/domain-plan-summary.json"
domain_digest="$(cat "$MELTIPLY_RELEASE_DIR/domain-plan.sha256")"
bun run release:approve traffic "$MELTIPLY_RELEASE_INPUT" \
  "$MELTIPLY_RELEASE_DIR/domain.tfplan" "$USER" \
  "approve $MELTIPLY_ENVIRONMENT $MELTIPLY_RELEASE_SHA $domain_digest"
MELTIPLY_RELEASE_CONFIRM="apply $MELTIPLY_ENVIRONMENT domain $MELTIPLY_RELEASE_SHA $domain_digest" \
  ./scripts/infra/release-transition.sh apply domain
bun run release:smoke --phase live
```

Both domain **plan and apply** reject missing/mismatched frontend evidence before
backend initialization: same SHA/release ID, reviewed Worker and API binding,
source/built config digests and candidate deployed at 100%. The domain transition
changes only custom domains; Queue delivery remains paused and Cron remains
empty. Live smoke verifies the app's `/api/v1/health`, release identity/environment,
and actual API version traffic. Inspect the app in a browser and verify email
delivery with your controlled owner account; smoke does not exercise those flows.

### Queue resume, Cron activation, and manifest

Only after live smoke and operator acceptance, review the narrow Queue resume:

```bash
./scripts/infra/release-transition.sh plan unpause "$protected/unpause.tfvars"
.bin/tofu -chdir=infra/cloudflare show "$MELTIPLY_RELEASE_DIR/unpause.tfplan"
cat "$MELTIPLY_RELEASE_DIR/unpause-plan-summary.json"
unpause_digest="$(cat "$MELTIPLY_RELEASE_DIR/unpause-plan.sha256")"
bun run release:approve queue-resume "$MELTIPLY_RELEASE_INPUT" \
  "$MELTIPLY_RELEASE_DIR/unpause.tfplan" "$USER" \
  "approve $MELTIPLY_ENVIRONMENT $MELTIPLY_RELEASE_SHA $unpause_digest"
MELTIPLY_RELEASE_CONFIRM="apply $MELTIPLY_ENVIRONMENT unpause $MELTIPLY_RELEASE_SHA $unpause_digest" \
  ./scripts/infra/release-transition.sh apply unpause
bun run release:cron --phase cron-activate --apply \
  --confirm "release $MELTIPLY_ENVIRONMENT $MELTIPLY_RELEASE_SHA" \
  --plan-digest "$unpause_digest" \
  --approval-metadata "$MELTIPLY_RELEASE_DIR/approval-queue-resume.json"
bun run release:manifest \
  --approval-metadata "$MELTIPLY_RELEASE_DIR/approval-foundation.json" \
  --approval-metadata "$MELTIPLY_RELEASE_DIR/approval-traffic.json" \
  --approval-metadata "$MELTIPLY_RELEASE_DIR/approval-queue-resume.json"
```

The actual gate order is intentional: `unpause` changes only delivery flags on
all eleven workload Queues; `cron-activate` then requires those active IaC outputs,
Automation deployment evidence and the **previous successful paused live smoke**.
It deploys and polls the exact canonical hourly/daily schedule set. Do not
activate Cron early, bypass its evidence, or describe Queue resume as atomic with
Cron activation. If Cron fails, the release is incomplete even though Queues may
already deliver; pause delivery with a newly reviewed `pause` plan while recovering.
`release:smoke --phase live` requires paused outputs, so do not rerun it against
the now-active state; retain the successful pre-unpause smoke.

`release-manifest.json` is the terminal redacted sign-off record, not a new deploy.
It validates matching environment/release identity, all three review receipts and
digests, phase plan summaries and post-apply outputs, restore/migration evidence,
all four Workers, API/Automation secret versions, version/live smoke, empty/active
Cron sets and OpenAPI provenance. Final outputs must equal the unpause snapshot
and prove the active selected installation. Retain the private session securely;
publish only the validated redacted manifest/evidence allowlist, never raw plans,
plan JSON, credentials, secret bundles, source config scratch or build assets.
Do not borrow evidence from the other environment.

First-run owner setup at `/sign-in` uses the protected `AUTH_SETUP_SECRET`;
registration closes after the owner exists. Keep that value server-only and
follow [owner and authentication policies](../../docs/self-hosting.md#authentication-invitations-and-owner-recovery).
Record deployment-specific backup/restore drills and measured costs separately;
a snapshot or a complete manifest establishes neither full recovery nor a bill.

### Updating an existing installation

Use a new clean checkout/session, the same installation's backend, and
`deployment_mode: "update"`. Preserve the existing staging names. The transition
phase names and semantics stay `pause`, `domain`, and `unpause`; do not replay
foundation or `paused-consumers` against an attached stack:

1. Plan/review/apply `pause` with `$protected/pause.tfvars` exactly as foundation
   above, but create the `foundation` approval against `pause.tfplan` and use
   `pause-plan.sha256` for `foundation_flags`. Render the paused outputs.
   Run `release:cron --phase cron-pause "${foundation_flags[@]}"` to remove and
   verify all Automation schedules **before** any Worker upload.
2. Create `release:restore-point "${foundation_flags[@]}"`; run
   `release:migrate --phase expand "${foundation_flags[@]}"`. No destructive schema
   contraction is allowed during rollout.
3. Use `release:deploy --phase state-update --step upload` then `--step activate`;
   for `automation-update`, use `--step upload`, inject `release:secrets --phase
   automation`, then `--step activate`. Pass `foundation_flags` to every mutation.
4. Use `release:deploy --phase api-update --step upload`, then `release:secrets
   --phase api`, both with `foundation_flags`; API activation is the staged rollout,
   not an `api-update --step activate` command. Use `frontend-update --step upload`
   then `--step activate` with `foundation_flags` (no frontend secrets).
5. Run version smoke; plan/review `domain` and create its `traffic` receipt as
   above even when domain attachments are unchanged. Apply the reviewed domain
   plan. Frontend evidence is mandatory for updates too.
6. Run each API stage in order, stopping on any failed smoke:

   ```bash
   for percentage in 5 25 50 100; do
     bun run release:deploy --phase api-rollout --percentage "$percentage" --apply \
       --confirm "release $MELTIPLY_ENVIRONMENT $MELTIPLY_RELEASE_SHA" \
       --plan-digest "$domain_digest" \
       --approval-metadata "$MELTIPLY_RELEASE_DIR/approval-traffic.json" || break
     bun run release:smoke --phase live --percentage "$percentage" || break
   done
   ```

   Review all four successful outcomes before proceeding; breaking the loop is
   **not** acceptance. Both Queue delivery and Cron remain paused throughout.
7. Follow the same approved `unpause`, `cron-activate`, and manifest commands.
   Keep previous versions, snapshot and rollback evidence until acceptance.

### Async acceptance

The R2 acceptance probe (`staging:r2:check` / `staging:r2:run`) remains a dedicated
**staging-only probe**, not the production release path. It requires a controlled
user and Workspace through `MELTIPLY_STAGING_ACCEPTANCE_USER_ID`,
`MELTIPLY_STAGING_ACCEPTANCE_ORG_ID`, and `MELTIPLY_STAGING_BEARER_TOKEN`; it checks
those identities before mutation. Keep sufficient upload/storage headroom. It
verifies object lifecycle cleanup, not a billing endpoint or live Provider review.

API smoke is not async acceptance. There is no synthetic canary Queue: approved
real staging messages and durable outcomes are still required for async acceptance.
An installation with false Provider flags cannot supply live publishing acceptance.

## Queue operations and costs

```bash
bun run queue:metrics --environment staging --workload publish-tiktok
bun run queue:replay \
  --environment staging \
  --workload publish-tiktok \
  --operator "$USER" \
  --reason "INC-123 provider recovered"
```

Replay is a dry run until `--apply` and environment/workload confirmation are
provided. It emits payload-free audit JSON and fails on partial, rejected, or
ambiguous settlement. The operator token needs account-scoped Queues Read/Write.

`bun run cost:model` reports known charges and explicit unknowns, not a bill.
All checked-in deployment usage is unmeasured. Populate protected copies of
[`cost-model-inputs.json`](../../scripts/infra/cost-model-inputs.json) and
[`endpoint.json`](../neon/endpoint.json), then run:

```bash
bun run cost:model --input /protected/usage.json --neon-config /protected/neon.json
bun run cost:require-complete --input /protected/usage.json --neon-config /protected/neon.json
```

Use one measured billing month and account scope for usage and business units.
Keep unknown values `null` and update `expected_unknown_inputs` to match; zero
means measured zero, not missing data. The complete gate rejects any unknown
usage/endpoint setting. Retrieve Neon settings and CU-seconds with the commands
embedded in `endpoint.json`; divide CU-seconds by 3,600, not endpoint uptime.
The assumed Neon Launch tariff is not evidence of the installation's actual plan.

Container accounting includes active vCPU-seconds, **provisioned** GiB-seconds
and disk GB-seconds, plus regional egress. RSS is not billable provisioned memory.
Four simultaneously running `standard-3` instances provision up to eight vCPUs,
32 GiB memory and 64 GB disk; actual active time and egress remain unknown.
Record cold-start latency and provisioned lifetime as well as native CPU/RSS.
The managed processor's two-minute inactivity timeout applies after requests
finish, not while FFmpeg is running; the next job may pay another cold start.

Pricing sources and retrieval dates live beside each tariff, including
[Containers](https://developers.cloudflare.com/containers/platform/pricing/) and
[Neon](https://neon.com/pricing). The current
[Workers Logs schedule](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
expires after November 30, 2026. The calculator rejects a later projection until
that tariff is explicitly reverified; it does not invent the replacement price.

### Telemetry and failure notifications

Managed application success logs and traces sample at 10%. Platform logs remain
unsampled, with invocation logs enabled: head sampling cannot promise to keep
all warnings/errors. Workspace Audit, Outbox and job-ledger persistence are not
sampled. Traces and sampled success logs are never the source of Queue alerts.

The repository does **not** provision a notification policy. Configure an
operator-owned HTTPS JSON receiver and a supervised, five-minute monitor outside
the application request path:

```bash
# Supply CLOUDFLARE_ACCOUNT_ID, a Queues Read token in CLOUDFLARE_API_TOKEN,
# and MELTIPLY_ALERT_WEBHOOK_URL through the monitor's protected environment.
bun run queue:alert --environment staging --workload publish-threads \
  --max-backlog 1000 --max-age-seconds 46800
```

Run it for every workload/DLQ, with thresholds derived from actual traffic.
Publish queues contain intentionally delayed messages (up to twelve hours);
transport age/backlog is **not** scheduled-publication lateness. The example
allows that delay plus an hourly recovery margin; monitor actual due-to-published
lag separately from durable Distribution outcomes. Other workload thresholds
need their own service-time budgets.

The monitor uses point-in-time
[Queue metrics](https://developers.cloudflare.com/queues/observability/metrics/),
not sampled GraphQL aggregates. Any DLQ backlog alerts. Missing/invalid metrics
also notify and fail; rejected notification delivery fails without exposing
message bodies or webhook secrets. Exit 0 means healthy, 2 means an unhealthy
notification was accepted, and 1 means monitoring/delivery failed. The supervisor
must page on missed runs and exit 1 independently of this webhook. Test actual
receipt and outage escalation before declaring alerts operational; local HTTP
fixtures cannot certify a live destination.

### Bounded publication capacity

`PUBLISH_BATCH_CONCURRENCY=1` is the safe serial default. Setting it to `2`
overlaps at most two **different external Provider accounts** within one publish
batch. Account identity comes from PostgreSQL, not the Queue payload; messages
for the same account stay ordered. Keep OpenTofu's consumer-concurrency limit at
one invocation per Provider Queue. Asset jobs and other queues remain serial.
Do not raise consumer concurrency without a separate cross-invocation account
coordination design. Existing persisted rate budgets, leases, Ambiguous outcome
reconciliation, backoff, Outbox and DLQ rules are unchanged.

The hosted `performance-backend` lane runs the real Queue handler in workerd
with PostgreSQL and a controlled slow Provider. Its `queue-capacity.json` records
serial/bounded timing, head-of-line delay, maximum active calls and redelivery
outcomes. This is a capacity experiment, not a live Provider quota measurement.
Enable the bounded mode only after its latency/throughput gain is observed and
the installation's Provider budget supports it.

[Run 40192396395](https://github.com/MeltiplyOrg/meltiply/actions/runs/40192396395)
at `316c93e` exercised five publications across four external accounts, one
500 ms controlled call and four 50 ms calls. Three alternating samples per mode
produced these rounded observed ranges:

| Mode        | Whole batch ms | First independent account completion ms | Maximum simultaneous calls |
| ----------- | -------------: | --------------------------------------: | -------------------------: |
| Serial      |        905–938 |                                 630–661 |                          1 |
| Bounded two |        657–665 |                                 106–114 |                          2 |

Every sample persisted five published outcomes, kept same-account concurrency
at one, and acknowledged redelivery without another Provider write.
[Raw observations](../../docs/benchmarks/results/2026-10-25-authenticated/queue-capacity.json)
demonstrate reduced head-of-line blocking under this controlled latency skew,
not a production throughput or quota guarantee. Serial remains the default.

### Controlled API placement experiment

Leave deployment placement unchanged until measured. Prepare two isolated API
versions with identical code/data/authentication; vary only placement. Supply a
live test session through `MELTIPLY_BENCHMARK_TOKEN`, never a command-line token:

```bash
bun run benchmark:placement \
  --baseline https://baseline-api.example.com \
  --candidate https://candidate-api.example.com \
  --workspace 20000000-0000-4000-8000-000000000005 \
  --start 2026-07-01T00:00:00Z --end 2026-10-01T00:00:00Z \
  --location actual-client-region --samples 30
```

The read-only experiment alternates paired requests, discards warm-up, consumes
responses, and records p50/p95/p99, bytes, `cf-placement` and `cf-ray` without
private bodies. Run from representative client regions after placement learning;
compare complete forwarding-inclusive user latency, not only origin duration.
[Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/)
affects fetch handlers, not named-entrypoint RPC. A local workerd/PostgreSQL
benchmark cannot establish managed placement gains.

### Acceptance targets and scaling decisions

These are engineering targets and an illustrative planning profile, **not
production observations or SLAs**. Evaluate live latency from declared client
regions with authentication, forwarding and response consumption included.

| Surface                                                            | Acceptance target                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Warm Channels/active Brand Profiles/identical Analytics navigation | No resource GET within the five-minute freshness window; own mutations and Analytics Refresh do not wait for expiry     |
| Warm Posts navigation                                              | No collection GET within one minute; loaded active work uses bounded detail reads, not repeated page chains             |
| Visible connected publication/Asset progress                       | Next ten-second polling opportunity plus request duration; hidden/offline tabs resume on return                         |
| Cold Posts page / complete Analytics page                          | p95 under 1 second and p99 under 2 seconds at 20 concurrent active sessions; report misses and authorization separately |
| Normal scheduled publication dispatch                              | p95 due-to-attempt lag under 30 seconds, excluding external Provider completion                                         |
| Hourly durable recovery                                            | Eligible work rediscovered within 65 minutes; foreground delivery does not depend on the hourly backstop                |
| Authorization changes                                              | No server-side stale authorization window; every HTTP request checks the live session and Workspace access              |

Illustrative capacity: 100 daily active users, two sessions/user/day and 20 views
per session imply 4,000 view actions/day before cache reuse; plan separately for a
20-session peak. At 300 Posts/day and two destinations/Post, plan for 600
publications/day and a burst of 60 due in one minute. Provider account diversity
matters: one hot account still serializes even in bounded mode. With a planning
assumption of 90 retained captures/Distribution, that publication rate adds about
1.62 million snapshots per 30 days; this is not the scheduler's capture contract.
The benchmark's 300-Distribution/27,000-snapshot history is a regression fixture,
not proof of that larger capacity.

For each Provider Queue, require arrival rate × measured mean service time below
effective concurrency, with at least 2× burst headroom. Include retries and
account-serialization skew. Database demand depends on uncached actions and the
complete authenticated statement count, not UI clicks alone.

Before increasing Neon compute, capture slow SQL, `EXPLAIN (ANALYZE, BUFFERS)`,
origin-pool wait, connection utilization, CPU and working-set/cache misses.
Investigate sustained CPU over 70%, origin connections over 70% of the reviewed
limit, pool-wait p95 over 50 ms, or hot-query p95 over 100 ms in three consecutive
15-minute windows. Fix avoidable work/index or lock problems first; then increase
the existing endpoint's reviewed CU ceiling with a cost cap and repeat the same
load. Do not introduce sharding, a replica or another cache from averages alone.
Retention, history growth and data skew must be included in the next capacity run.

Recovery design goals are **RPO ≤24 hours and RTO ≤4 hours**, not a claim about
the current installation. Self-hosting requires daily consistent off-host
PostgreSQL and stopped-runtime backups, protected environment/encryption keys,
the matching image revision, and periodic timed full restores. The hosted
disposable Compose restore records fixture timings only. Managed deployments
must verify Neon history/restore retention and recovery of object, Queue and
Durable Object state separately; a database restore alone is not full application
recovery. Do not declare these goals met without a timed deployment-specific
exercise and recorded backup age.
The [timed disposable full-restore evidence](../../docs/self-hosting.md#administration-and-recovery)
records successful amd64/arm64 acceptance; it does not replace the managed
deployment exercise or establish the RPO/RTO goals above.
