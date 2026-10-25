# Cloudflare infrastructure

This OpenTofu root manages staging account/zone resources only. Preview plans are
rejected: a preview stack needs isolated identifiers and state, not reused staging
resources. Worker code and version deployment remain Wrangler-owned.

## Ownership

| Owner               | Resources                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenTofu            | API domain, WAF/rate controls, private R2 bucket/CORS/lifecycle/events, Queues and DLQs, consumer retry/concurrency, Access, and release outputs |
| Wrangler            | Worker source/versions, compatibility/CPU settings, bindings, handler declarations, and Durable Object migrations                                |
| Protected bootstrap | Two distinct Hyperdrive configurations, validated by OpenTofu with query caching disabled                                                        |

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
