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

Database passwords, Provider credentials, auth/billing secrets, and encryption
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
