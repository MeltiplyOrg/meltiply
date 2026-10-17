# Cloudflare infrastructure

This OpenTofu root manages staging account/zone resources only. Preview plans are
rejected: a preview stack needs isolated identifiers and state, not reused staging
resources. Worker code and version deployment remain Wrangler-owned.

## Ownership

| Owner               | Resources                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenTofu            | API domain, WAF/rate controls, private R2 bucket/CORS/lifecycle/events, Queues and DLQs, consumer retry/concurrency, Access, notifications, and release outputs |
| Wrangler            | Worker source/versions, compatibility/CPU settings, bindings, handler declarations, and Durable Object migrations                                               |
| Protected bootstrap | Two distinct Hyperdrive configurations, validated by OpenTofu with query caching disabled                                                                       |

Staging Queue consumers are OpenTofu-owned; the Automation Wrangler config
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

For an authenticated staging plan:

```bash
.bin/tofu -chdir=infra/cloudflare init \
  -reconfigure \
  -backend-config=/protected/backend.hcl
MELTIPLY_IAC_TFVARS=/protected/staging.tfvars bun run iac:check
```

Use [backend.hcl.example](backend.hcl.example) and
[staging.tfvars.example](staging.tfvars.example) as templates. Supply backend
credentials through `TF_HTTP_USERNAME`/`TF_HTTP_PASSWORD`. The state service must
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

Use separate account-scoped identities for Hyperdrive bootstrap, infrastructure
planning/apply, Worker deployment, and protected secret injection. Grant only
the required resource permissions; keep the secret-writing capability confined
to the injection step.

## Release and rollback

Release transitions are explicit: create the paused foundation, deploy State and
triggerless Automation, attach consumers while paused, deploy API, then attach
its domain. Verify version/live smoke before a fresh approved plan enables Queue
delivery and the exact canonical Cron schedule. Updates pause Queues and remove
and verify empty Automation schedules before rollout.

Use the [release scripts](../../scripts/release/) for orchestration and evidence.
`release:smoke` checks candidate/live identity and rollout traffic;
`release:manifest` validates the evidence set and writes a redacted manifest.
Record plan digests, resource outputs, Worker versions, migration checksums,
schedule-set evidence, and OpenAPI provenance.

### Operator-run deployment

No CI service or CI account is required to deploy. Use a trusted workstation
with the pinned Node/Bun/OpenTofu tools, Cloudflare deployment credentials, and
protected backend/tfvars files. Populate
[`release-input.example.json`](../../scripts/release/release-input.example.json)
for your own account, domains, database, and exact checked-out commit. Keep the
checkout clean and use a new ignored release directory for each release.

Plans and review receipts are local operator records, not authenticated approvals
or signatures. Filesystem permissions and deployment credentials are the trust
boundary. Never download or apply plans produced by untrusted contributor code.

For the initial paused foundation:

```bash
export MELTIPLY_RELEASE_INPUT=/protected/release.json
export MELTIPLY_RELEASE_SHA="$(git rev-parse HEAD)"
export MELTIPLY_RELEASE_DIR="$PWD/.release/initial-deployment"
export MELTIPLY_TF_BACKEND_CONFIG=/protected/backend.hcl

bun run release:preflight:offline
./scripts/infra/staging-transition.sh plan foundation /protected/foundation.tfvars
.bin/tofu -chdir=infra/cloudflare show "$MELTIPLY_RELEASE_DIR/foundation.tfplan"
# Review the actual plan and policy summary before confirming their exact bytes.
digest="$(cat "$MELTIPLY_RELEASE_DIR/foundation-plan.sha256")"
bun run release:approve foundation "$MELTIPLY_RELEASE_INPUT" \
  "$MELTIPLY_RELEASE_DIR/foundation.tfplan" "$USER" \
  "approve $MELTIPLY_RELEASE_SHA $digest"
MELTIPLY_RELEASE_CONFIRM="apply foundation $MELTIPLY_RELEASE_SHA $digest" \
  ./scripts/infra/staging-transition.sh apply foundation
export MELTIPLY_RELEASE_IAC_OUTPUTS="$MELTIPLY_RELEASE_DIR/iac-outputs.json"
bun run release:render
```

The apply checks the checkout, saved-plan digest, and explicit phase/commit/digest
confirmation before invoking OpenTofu, then removes the sensitive raw plan and
plan JSON. Create the review receipt **before** applying. Never reuse a release
directory for a different commit or release ID.

Continue in this order, following each command's `--help` for phase/step arguments:

| Order | Transition                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `release:restore-point`, then `release:migrate --phase bootstrap` for a new deployment or `--phase expand` for a compatible update.        |
| 2     | Deploy State, inject protected secrets, then deploy Automation without triggers.                                                           |
| 3     | Plan/review/apply `paused-consumers`; refresh rendered configs from its outputs.                                                           |
| 4     | Deploy API and inject its secrets; verify candidate identity with `release:smoke`.                                                         |
| 5     | Plan/review `domain`, create its `release:approve traffic` receipt before applying, then verify live identity.                             |
| 6     | For updates, use the traffic receipt with `release:deploy --phase api-rollout` at 5%, 25%, 50%, and 100%, smoking each stage.              |
| 7     | Plan/review `unpause`, create `release:approve queue-resume`, apply it, then enable the exact canonical Cron schedule with `release:cron`. |
| 8     | Finish live smoke and `release:manifest`; do not run destructive schema contraction during rollout.                                        |

Every release CLI command that applies or deploys a change requires `--apply`,
the exact `--confirm "release staging <git-sha>"`, `--plan-digest`, and the
appropriate `--approval-metadata "$MELTIPLY_RELEASE_DIR/approval-<scope>.json"`.
These requirements do not apply to the foundation apply performed by
`staging-transition.sh`. The scopes are `foundation`, `traffic`, and
`queue-resume`; each receipt binds one reviewed plan to the same release session.
Never bypass missing restore-point, migration, identity, traffic, Queue, or Cron
evidence.

An update first plans/reviews/applies `pause`, verifies Queue delivery is paused,
and removes/verifies Automation schedules before changing Worker versions.
Retain the previous versions and restore-point evidence until acceptance is complete.

The R2 acceptance probe (`staging:r2:check` / `staging:r2:run`) requires a
dedicated staging user and workspace, configured through
`MELTIPLY_STAGING_ACCEPTANCE_USER_ID`, `MELTIPLY_STAGING_ACCEPTANCE_ORG_ID`, and
`MELTIPLY_STAGING_BEARER_TOKEN`. It verifies those identities before mutation;
no subscription or payment configuration is needed. Keep sufficient upload and
storage headroom for the probe. The API enforces community quotas, and admission
failures produce failed evidence and run resource cleanup. The probe verifies
object lifecycle cleanup, not a billing usage endpoint.

### Object storage provider

Workers read stored assets from Cloudflare R2 unless `OBJECT_STORAGE_PROVIDER`
says otherwise. To store assets in an S3-compatible service instead, set
`OBJECT_STORAGE_PROVIDER=s3` together with `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` (plus optional `S3_REGION` and
`S3_FORCE_PATH_STYLE`, which defaults to `true`). Uploads, multipart uploads,
media processing, retention purges, and private media delivery all follow the
selected provider; presigned capabilities keep the same shape either way.

Two consequences for this Terraform-managed deployment:

- The `ASSETS` R2 bucket binding stays declared in the Workers' `wrangler.jsonc`
  and here, so the bucket must continue to exist. An S3 deployment simply never
  reads through it; the R2 lifecycle, CORS, and event resources become unused
  rather than removed.
- `release:deploy` renders `R2_*` from the IaC outputs and requires the `R2_*`
  secrets, because the R2 bucket is the resource Terraform manages here. An S3
  deployment therefore configures `OBJECT_STORAGE_PROVIDER` and the `S3_*`
  settings outside that flow — the bucket and region as Worker variables
  (`wrangler versions secret`/`wrangler secret put` or the dashboard), never as
  Terraform variables, so credentials stay out of state and out of logs.
  `S3_ENDPOINT` must be HTTPS.

`/api/v1/ready` reports the bindings the selected provider needs, and reports a
rejected endpoint or addressing switch as unavailable, so readiness never shows
a green probe over a deployment whose asset requests would fail.

API smoke is not async acceptance. There is no synthetic canary Queue: approved
real staging messages and durable outcomes are still required for async acceptance.
Worker rollback changes routing/code, not PostgreSQL, R2, Queue, Workflow, or
Durable Object state. Pause producers and consumers; use forward storage fixes.

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

`bun run cost:model` reports the checked-in profile's known lower bound, not a
complete estimate. Use `cost:require-complete` only with a populated staging/release
profile; the incomplete repository profile intentionally fails that gate.
