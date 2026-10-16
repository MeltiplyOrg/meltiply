# Publishing Worker cost research

Researched 2026-09-13. Scope: checked-in implementation and current official
Cloudflare pricing, not a live-account billing audit. All amounts are USD on
Workers Standard/Paid pricing, before taxes or negotiated discounts.

## Conclusion

[INFERENCE] Queue delivery and Worker CPU are inexpensive for modest publishing
volume. The important multiplier is recurring analytics and comment sync after a
successful publication, not leaving a scheduled job waiting. A distribution can
produce hundreds of sync messages during its first 30 days, plus later analytics.
Database compute, media storage/operations, logs, and other application traffic
must be added before estimating the full application bill.

The existing cost model is not a measured forecast: running `rtk bun run cost:model`
returned `complete: false`, a $5 known monthly lower bound in all three scenarios,
and unknown `usage_1x.neon_compute_cu_hours`. Its Cloudflare usage and business
volume inputs are zero. See [inputs](cost-model-inputs.json), lines 288–351.

## Official billing rules

Sources retrieved on the research date:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  (page updated 2026-08-28).
- [Workers CPU and duration definitions](https://developers.cloudflare.com/workers/platform/limits/)
  (page updated 2026-09-05).
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
  (page updated 2026-04-21).
- [Batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/).
- [Queue message delay API](https://developers.cloudflare.com/queues/configuration/javascript-apis/).

| Meter                       | Included on Paid        | Overage                                                   |
| --------------------------- | ----------------------- | --------------------------------------------------------- |
| Account subscription        | Workers Paid            | $5/month minimum, not $5 per Worker                       |
| Worker requests/invocations | 10 million/month        | $0.30/million                                             |
| Worker CPU                  | 30 million CPU ms/month | $0.02/million CPU ms                                      |
| Queue operations            | 1 million/month         | $0.40/million                                             |
| Workers log events written  | 20 million/month        | $0.60/million                                             |
| Hyperdrive queries          | Unlimited on Paid       | No additional Hyperdrive query fee; Neon remains separate |

These are shared allowances, not a fresh allowance for each publication or Worker.
The Queue pricing example totals usage over the application; do not multiply the
included allowance by the five publishing queues.

### What execution time means

Worker CPU is time executing code. Waiting for `fetch()`, database queries, or
other network I/O does not count as CPU. Worker wall-clock duration has no separate
charge under this pricing model. For example, a publication that waits 30 seconds
on a provider but executes 20 ms of code consumes 20 ms of CPU, not 30,000 ms.
Serialization, encryption, parsing, and executing database-client code still use CPU.
The example is illustrative, not a measurement of this application.

A consumer invocation handles a batch. Larger batches reduce consumer invocations,
but not per-message Queue operations. An empty push queue does not invoke the
Worker or generate empty reads. Pulling an empty DLQ can incur reads; merely
configuring a pull consumer is not the same as polling it.

An API-to-automation Service Binding RPC adds no extra request fee on Standard;
the CPU used in both Workers is counted. Cron executions count as invocations and
consume actual CPU; the pricing page demonstrates 720 hourly executions in a
30-day month. There is no always-on Worker/server rental beyond the account plan.

### What a queue message costs

A successfully delivered message normally consumes three operations: write, read,
delete. Each operation is metered per 64 KB chunk, including roughly 100 bytes of
internal metadata. Sending ten messages in one batch still normally costs 30
operations. Each redelivery adds a read; DLQ handling adds operations too.

Delaying delivery supports up to 86,400 seconds. The published tariff has no
separate waiting-duration charge for delayed messages. A retry that reuses the
same message is different from a reconciliation/sync that creates a new message:
the latter starts another write/read/delete lifecycle.

For account-wide monthly totals R (billable invocations), C (CPU ms), Q (Queue
operations), and L (log events), the relevant Standard cost components are:

```text
5
+ max(0, R - 10,000,000) / 1,000,000 * 0.30
+ max(0, C - 30,000,000) / 1,000,000 * 0.02
+ max(0, Q - 1,000,000) / 1,000,000 * 0.40
+ max(0, L - 20,000,000) / 1,000,000 * 0.60
```

This excludes R2, Neon, Durable Objects, Workflows, and any other services.
To estimate an incremental workload on an existing account, subtract the cost
before the workload from the cost after it; do not subtract allowances twice.

## Current publishing execution

1. The API records a distribution and its outbox command transactionally.
   Schedules beyond the 24-hour Queue delay horizon remain in PostgreSQL until
   eligible for arming. See [distribution service](../../workers/api/src/distribution-service.ts),
   lines 499–529, and [horizon](../../packages/domain/src/due-work.ts), lines 1–8.
2. After mutation, the API can call automation's eager outbox relay through a
   Service Binding. The relay claims a bounded batch with row locks, groups events
   by platform queue, sends JSON messages with delivery delays, and records the
   relay outcome. See [automation entrypoint](../../workers/automation/src/index.ts),
   lines 765–779, and [outbox](../../workers/automation/src/outbox.ts), lines 59–105
   and 296–438. Database operations and Queue writes are real work; waiting for the
   schedule is not a continuously running Worker.
3. Each platform has its own publishing queue. Infrastructure configures batch
   size 5, maximum concurrency 1 per platform, five retries, and a DLQ. Analytics
   and comments use batches up to 10 and maximum concurrency 3 each. See
   [workloads](../../infra/cloudflare/main.tf), lines 2–60, and
   [consumers](../../infra/cloudflare/modules/queues/main.tf), lines 58–95.
4. The queue handler iterates messages sequentially, calls
   `processDistributionMessage()`, and acknowledges each completed message. The
   processor prepares/leases database state, executes the provider adapter, and
   records the outcome. See [handler](../../workers/automation/src/index.ts),
   lines 552–684, and [processor](../../workers/automation/src/distribution.ts),
   lines 1251–1375. Batch size is a maximum: sparse traffic may deliver one message
   per invocation. Concurrency is a throughput limit, not reserved paid capacity.
5. Media resolution uses an R2 metadata lookup and signed download URL for remote
   ingest, or an R2 object stream for byte uploads. Media bytes are not the
   publishing queue payload. See [media resolver](../../workers/automation/src/provider-media.ts),
   lines 97–147. R2 operations/storage are separate from Worker CPU billing.
6. Provider processing can require additional reconciliation messages. The code
   specifies a 20-second desired provider poll interval and a 90-poll budget;
   general reconciliation has a separate 10-attempt bound. These are not 90
   guaranteed polls or a guaranteed wall-clock completion window: outbox relay
   and queue delivery timing affect actual execution. See
   [poll constants](../../workers/automation/src/due-work.ts), lines 48–63, and
   [outcome handlers](../../workers/automation/src/distribution.ts), lines 829–851
   and 1094–1235.
7. A successful publication dispatches initial analytics and comment messages;
   successful syncs enqueue their next delayed trigger. See
   [initial dispatch](../../workers/automation/src/distribution.ts), lines 599–652,
   and [sync scheduling](../../workers/automation/src/provider-sync.ts),
   lines 792–821 and 891–923.

The same automation Worker also handles assets, token refresh, replies, syncs,
and maintenance, so its aggregate CPU is not publishing-only. The configured
hourly and daily cron expressions imply 750 trigger firings in a 30-day month if
both are deployed. They run bounded maintenance work, not one cron per post.
See [cron configuration](../../workers/automation/wrangler.jsonc), lines 54–62,
and [scheduled task list](../../workers/automation/src/index.ts), lines 426–494.
Publishing does not use `ReplyWorkflow`; comment replies do.

The checked-in configuration is staging-oriented, has live-provider acceptance
flags set false, and infrastructure bootstrap defaults pause queue delivery and
do not attach consumers. Release settings can override these. These files do not
prove what is currently deployed or what the account is being charged. See
[Worker variables](../../workers/automation/wrangler.jsonc), lines 26–37, and
[infrastructure defaults](../../infra/cloudflare/variables.tf), lines 40–55.

## Recurring sync is the main message multiplier

The actual cadence functions are in
[provider-sync.ts](../../workers/automation/src/provider-sync.ts), lines 497–540.
Active analytics means tracked metrics changed; active comments means the last
page returned comments. Neither means the customer merely logged in.

| Publication age | Analytics active / inactive | Comments active / inactive |
| --------------- | --------------------------- | -------------------------- |
| First day       | 15 / 30 minutes             | 10 / 20 minutes            |
| Days 1–7        | 1 / 2 hours                 | 30 / 60 minutes            |
| Days 7–30       | 6 / 24 hours                | 3 / 24 hours               |
| Days 30–366     | Daily                       | Demand-driven              |
| From day 366    | Scheduled analytics stops   | Demand-driven              |

The inactive branch for age >= 7 days takes precedence over later ladder values.
Comments become demand-driven at 30 days; analytics stops at 366 days. See
[age bounds](../../packages/domain/src/due-work.ts), lines 16–36. Old-comment
on-demand claims are bounded to ten distributions per request and a minimum
15-minute interval per distribution, in
[due-work.ts](../../workers/automation/src/due-work.ts), lines 84–94.

Polling is conditional on provider capability, readable publication state,
connected account, valid credentials, and enabled behavior. See
[capability filtering](../../workers/automation/src/provider-sync.ts), lines 114–135,
and [eligibility](../../workers/automation/src/due-work.ts), lines 430–478.
These calculations must not be applied to every stored distribution indiscriminately.

### Calculated first-30-day scenarios

[INFERENCE] For one eligible publication with both workloads running, continuous
all-inactive versus all-active cadence approximations give:

```text
Inactive analytics: 48 + 6*12 + 23*1 = 143 runs
Inactive comments: 72 + 6*24 + 23*1 = 239 runs
Active analytics:   96 + 6*24 + 23*4 = 332 runs
Active comments:   144 + 6*48 + 23*8 = 616 runs
Including one publishing message: about 383 or 949 messages
```

These are cadence integrals, not exact queue counts or hard lower/upper bounds.
Initial samples, age-boundary delivery, and processing latency shift counts.
Pagination immediately schedules more messages; errors, retries, cancellation,
reconciliation, and recovery can add more. Both scenarios exclude those effects,
old-publication analytics, token refresh, and other application traffic.

For a cohort observed over its complete first 30 days, assuming messages fit one
64 KB billing chunk, successful delivery without retries, and otherwise unused
monthly Queue allowance:

| Platform publications in cohort | Approximate messages | Queue charge only |
| ------------------------------- | -------------------- | ----------------- |
| 1,000                           | 383,000–949,000      | $0.06–$0.74       |
| 10,000                          | 3.83–9.49 million    | $4.20–$10.99      |
| 100,000                         | 38.3–94.9 million    | $45.56–$113.48    |

One asset sent to five platform accounts is five publications. This is not a
calendar-month forecast for posts arriving gradually, nor a mature-account
forecast with older cohorts still receiving daily analytics.

Worker CPU is additional. With a purely illustrative average of 10 ms per message
(including apportioned batch overhead), these scenarios add $0.17–$1.30 CPU at
10,000 publications, or $7.06–$18.38 at 100,000, assuming otherwise unused CPU
allowance. Actual publishing/upload CPU and sync CPU differ; no local timing is
being represented as Cloudflare billable CPU. Request fees depend on actual batch
occupancy, plus API, cron, and other invocation traffic. Add the $5 account base
only once, and add logs and external services separately.

## Cost controls and measurement gaps

Existing protections include delayed delivery, bounded batches, explicit per-message
acknowledgement, state/lease checks, retry ceilings, cached provider rate-limit
parking, and terminating old sync schedules. See
[distribution preparation](../../workers/automation/src/distribution.ts),
lines 158–225 and 274–421, plus the execution sources above.

The Worker sets `cpu_ms: 300000`; that is a configured limit, not CPU reserved or
charged on every invocation. Persisted invocation logs and traces are configured
at sampling rate 1, while `LOG_SAMPLE_RATE` is 0.1 for application logging. Do not
interpret that application variable as a blanket 90% reduction of all stored
observability data. See [configuration](../../workers/automation/wrangler.jsonc),
lines 9–28. Log-event volume should be measured separately.

[INFERENCE] Frequent sync-driven PostgreSQL activity may keep Neon compute awake
and produce more database cost than the corresponding Queue bill. This requires
Neon compute measurements to quantify; no dollar estimate is asserted here.

For a real forecast, collect a representative period of:

- Account plan and deployed queue/cron/provider-enable settings.
- Queue writes, reads, deletes, retries, DLQ operations, payload sizes, and actual
  batch occupancy per workload.
- Cloudflare billable CPU and invocations for automation, API, and other Workers.
  Application `latency_ms` measures elapsed time and must not substitute for CPU.
- Active distribution counts by publication age and supported workload;
  successful publications, provider poll counts, sync pages, and failures.
- Stored log-event totals, Neon CU-hours/storage, and R2 storage/operations.

Populate the existing [cost model inputs](cost-model-inputs.json) rather than
building a second billing calculator. The current $5 output is only a lower bound.

## Verification

- `rtk bun run cost:model`: passed execution; reported incomplete projection and
  $5 known lower bound at 1x, 3x, and 10x. This proves the model runs, not that the
  application costs $5.
- Evaluated cadence arithmetic and Queue/CPU formulas in a Python tool session;
  computed values are recorded above. No test or helper files were added.
- Documentation gate and formatting results are reported in the accompanying
  task response. No runtime code/configuration changes were made; code gates were
  not run. No live Cloudflare invoice or deployed CPU measurements were collected.
