# Media storage & optimization cost research

Primary-source cost findings for the media pipeline: Cloudflare R2 Standard
storage/operations/egress, Workers/Queues/Durable Objects orchestration,
Cloudflare Containers (ffmpeg + libvips) resource billing, and a comparison of
managed R2 vs customer-owned (BYOK) S3-compatible storage.

All prices are USD, captured 2026-10-06 from the cited pages (per-page
"last updated" dates noted). Nothing below is a measured benchmark: all
per-job compute and compression figures are labeled scenario assumptions.

## Product context this research serves

The latest product direction supersedes the initial optional, paid optimization
proposal: optimization is automatic internal cost reduction for managed-R2,
Post-owned Assets, with no user toggle or optimization fee. Validation and
publishing compatibility remain separate requirements. The specification selects
background work after validation and attachment to a saved Post, not after publication.
Keep the smaller validated result, or the original when there is no size reduction.

Managed storage is billed as retained-byte GB-month; BYOK has no Meltiply storage
charge. BYOK connections and migration are a separate ticket, not a dependency
of managed-R2 optimization. BYOK compute/transfer examples below are comparative
research, not a commitment to automatically compress customer-owned Assets.

Current processor anchor (repo, for resource-class reference only):

- `workers/automation/wrangler.jsonc`: container `instance_type: "standard-3"`,
  `max_instances: 4`, `scheduling_policy: "default"`; worker `cpu_ms: 300000`.
- `workers/automation/processor/Dockerfile`: Alpine 3.23 + ffmpeg/ffprobe +
  `vips-tools` + Node job service; `PROCESSOR_FFMPEG_THREADS=2`,
  `VIPS_CONCURRENCY=2`, `PROCESSOR_JOB_TIMEOUT_MS=540000` (9 min),
  `PROCESSOR_MAX_INPUT_BYTES=576716800` (550 MiB),
  `PROCESSOR_MAX_OUTPUT_BYTES=536870912` (512 MiB), `PROCESSOR_MAX_PENDING_JOBS=1`.
- `workers/automation/src/native-processor.ts`: `PROCESSOR_READY_TIMEOUT_MS =
  90_000`, `PROCESSOR_INACTIVITY_TIMEOUT_MS = 600_000` (each container parks
  running up to 10 min after its last job before the runtime stops it via
  `setInactivityTimeout`).

`standard-3` = 2 vCPU, 8 GiB memory, 16 GB disk
(<https://developers.cloudflare.com/containers/platform/limits/>, updated
2026-09-30). The 2 ffmpeg threads / 2 vips workers match the 2-vCPU
allocation; input/output byte caps fit well inside the 16 GB disk.

## Rate card — Cloudflare (Workers Paid plan)

Containers require the Workers Paid plan ("Available on Workers Paid plan" —
<https://developers.cloudflare.com/containers/>, updated 2026-09-30). Paid is a
$5/month minimum per account including Workers, KV, Hyperdrive, and Durable
Objects allotments (<https://developers.cloudflare.com/workers/platform/pricing/>,
updated 2026-10-02).

### R2 (<https://developers.cloudflare.com/r2/pricing/>, updated 2026-10-01)

| Dimension                                         | Standard                                   | Infrequent Access                              |
| ------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Storage                                           | $0.015 / GB-month                          | $0.01 / GB-month                               |
| Class A ops (writes, lists, multipart, lifecycle) | $4.50 / million                            | $9.00 / million                                |
| Class B ops (GET/HEAD)                            | $0.36 / million                            | $0.90 / million                                |
| Data retrieval                                    | none                                       | $0.01 / GB                                     |
| Egress to Internet                                | **$0** (incl. Workers API, S3 API, r2.dev) | **$0**                                         |
| Minimum storage duration                          | none                                       | 30 days (billed even if deleted/moved earlier) |
| Free tier / month                                 | 10 GB-month, 1M Class A, 10M Class B       | **excluded** — free tier is Standard-only      |

- GB-month = average of daily _peak_ storage over the 30-day billing period —
  a 1 GB object held 5 of 30 days bills ~0.167 GB-month. So transient staging
  in Standard costs proportionally little, and `DeleteObject`/`AbortMultipartUpload`
  are free ops.
- Usage is rounded **up** to the next billing unit (per million ops, per GB,
  per GB-month) — small accounts see step-function billing.
- Unauthorized (401) requests are not billed.
- Multipart: parts 5 MiB–5 GiB, ≤10,000 parts, ≤5 TiB objects; `UploadPart`,
  `CreateMultipartUpload`, `CompleteMultipartUpload` are each Class A
  (<https://developers.cloudflare.com/r2/objects/upload-objects/>, updated
  2026-07-29). In-progress parts count toward storage until completed or
  aborted (docs example aborts "so incomplete uploads do not count against
  storage"). A 512 MiB optimized write is therefore ~2–103 Class A ops
  depending on part size, plus a proportional share of a GB-month if the
  upload is abandoned un-aborted.

### Workers (<https://developers.cloudflare.com/workers/platform/pricing/>, updated 2026-10-02)

- Requests: 10M/month included, then $0.30/million. Subrequests not billed.
- CPU time: 30M CPU-ms/month included, then $0.02/million CPU-ms. No charge or
  limit for wall-clock duration — a Worker awaiting a container pays CPU only.
- Caps: 5 min CPU/invocation max (default 30 s; repo sets 300 s); 15 min for
  Cron/Queue-consumer invocations — comfortably above the 9-min job timeout,
  but orchestration logic must stay off the CPU path (it does; ffmpeg/vips run
  in the container).
- Free plan: 100k req/day, 10 ms CPU/invocation — irrelevant here since
  Containers are paid-only.

### Queues (<https://developers.cloudflare.com/queues/platform/pricing/>, updated 2026-04-21)

- Billed per 64 KB chunk written/read/deleted; +~100 B metadata/message.
- Paid: 1M ops/month included, then $0.40/million. Free plan: 10k ops/day.
- Normal delivery = 3 ops (write+read+delete) ⇒ ~$1.2×10⁻⁶ marginal per job
  message ≤64 KB.
- **Retries cost**: each retry = another read op per message; a message that
  hits max retries and lands in the DLQ = 4th-failure read + DLQ write. Media
  payloads must never ride inside the message — a 65 KB message already bills
  as 2 ops each way; carry references, not bytes.
- Paid retention default 4 days (up to 14); expired unread messages still cost
  write+delete.

### Durable Objects (<https://developers.cloudflare.com/durable-objects/platform/pricing/>, updated 2026-09-30)

Each container instance is owned by a DO (`MediaProcessorContainer` here), and
DO usage is billed on top of the container
(<https://developers.cloudflare.com/containers/platform/pricing/>).

- Requests: 1M/month included, then $0.15/million (each RPC call = 1 request).
- **Duration: wall-clock, not CPU.** 400k GB-s/month included, then
  $12.50/million GB-s, billed against a fixed 128 MB allocation regardless of
  actual use ⇒ $1.6×10⁻⁶ per active second ($0.0058/hour). Idle-but-
  hibernation-eligible is free, but **pending I/O keeps the object active** —
  the DO waiting on a 9-minute container job accrues ~$0.00086 of duration.
- Billable usage per dimension is rounded up to the next billing unit.
- Free plan: SQLite-backend DOs only, 100k req/day + 13k GB-s/day — moot since
  Containers are paid-only.

### Containers (<https://developers.cloudflare.com/containers/platform/pricing/>, updated 2026-10-05)

Billed per 10 ms that an instance is **actively running**; charges start when a
request is sent to the container (or manual `start()`), stop when the instance
sleeps after its inactivity timeout.

| Meter  | Included/mo (Paid) | Marginal rate           | Semantics                                      |
| ------ | ------------------ | ----------------------- | ---------------------------------------------- |
| Memory | 25 GiB-hours       | $0.0000025 / GiB-second | **provisioned** size of the instance type      |
| CPU    | 375 vCPU-minutes   | $0.000020 / vCPU-second | **active usage only**, up to instance vCPU cap |
| Disk   | 200 GB-hours       | $0.00000007 / GB-second | **provisioned** size                           |

- Network egress from containers (this is _our_ cost when writing to a
  customer bucket): NA & EU $0.025/GB (1 TB included/mo); "everywhere else"
  $0.04/GB (500 GB included); Oceania/Korea/Taiwan $0.05/GB (500 GB included).
  Region is determined by where the container runs, which Cloudflare schedules
  — not guaranteed same-location as its DO
  (<https://developers.cloudflare.com/containers/concepts/architecture/>,
  updated 2026-09-30).
- Cold starts "often in the 1–3 second range" (same page) — billed time.
- Shutdown: SIGTERM, up to 15 min grace, SIGKILL; the `Container` class default
  `sleepAfter` is 10 min, matching the repo's 600 s inactivity timeout.

Derived `standard-3` burn rates (8 GiB mem + 16 GB disk provisioned, 2 vCPU cap):

- Running CPU-idle: $0.072 + $0.004 = **$0.076/hour**
- CPU-saturated: + 2×$0.072/h = **$0.220/hour**
- The 10-minute idle park after each wake costs $0.0127 of provisioned
  memory+disk at ~0 CPU — under sparse traffic this _idle tail_, not the job,
  dominates per-job cost (see break-even section).

## Rate card — customer-owned S3-compatible storage (BYOK)

There is no universal "S3-compatible" price; storage, request, egress,
minimums, and fair-use egress caps all differ. BYOK support must treat these
as per-provider inputs. Representative examples, all captured 2026-10-06:

| Provider                                          | Storage                                                       | Requests                                                  | Egress to Internet                                                                                            | Minimums / notes                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **AWS S3 Standard** (us-east-1, explicit example) | $0.023/GB-mo (first 50 TB; $0.022 next 450 TB; $0.021 beyond) | PUT/COPY/POST/LIST $0.005/1k; GET $0.0004/1k; DELETE free | 100 GB/mo free globally, then $0.09/GB to 10 TB; $0.085/0.07/0.05 at higher tiers; inbound & same-region free | No min duration on Standard; S3-IA: $0.0125/GB-mo, 128 KB min object, 30-day min, $0.01/GB retrieval                |
| **Backblaze B2**                                  | $6.95/TB-mo, first 10 GB free                                 | Class A/B/C free (pay-as-you-go); Class D $0.004/10k      | Free up to 3× avg monthly storage, then $0.01/GB                                                              | No min file size or duration                                                                                        |
| **Wasabi**                                        | $7.99/TB-mo                                                   | Free\*                                                    | Free\* (\*fair use: monthly egress ≤ stored volume; API "reasonable")                                         | 1 TB monthly minimum; **90-day minimum storage duration** (early delete billed for remaining days); 4 KB min object |
| **DigitalOcean Spaces**                           | $5/mo base incl. 250 GiB; +$0.02/GiB-mo                       | none listed                                               | 1 TiB/mo included (incl. CDN), then $0.01/GiB; inbound free                                                   | Hourly proration on cancel                                                                                          |

Sources: AWS S3 pricing page (<https://aws.amazon.com/s3/pricing/>) and AWS
Price List API offer files (`AmazonS3` us-east-1: TimedStorage $0.023/GB-Mo,
Requests-Tier1 $0.005/1k, Requests-Tier2 $0.0004/1k — i.e., $0.0000004/request;
`AWSDataTransfer`: Global-DataTransfer-Out-Bytes $0 for 100 GB/mo; regional
DataTransfer-Out-Bytes $0.09/GB first 10 TB in US/EU mains, e.g. MSP1/NYC1/
EUN1/EUS1/USW2 SKUs); Backblaze <https://www.backblaze.com/cloud-storage/pricing>;
Wasabi <https://wasabi.com/pricing> + <https://wasabi.com/pricing/faq>;
DigitalOcean <https://docs.digitalocean.com/products/spaces/details/pricing/>
(updated 2026-07-13).

Two BYOK asymmetries worth internalizing:

1. **Reading the customer's original costs the customer egress.** A 1 GB
   source fetched from AWS S3 to our container costs the customer ~$0.09 of
   DTO (beyond their 100 GB global free tier) — on AWS, the read is more
   expensive for them than a month of storing the original. With Wasabi,
   repeated re-reads consume their egress fair-use budget (= storage volume).
2. **Writing the optimized result costs us container egress.** 1 GB written to
   a customer bucket = $0.025–$0.05 to us depending on the scheduling region —
   the same order as the entire compute cost of a small video job.

## Cost model

Definitions: `B` = original bytes (GB), `r` = optimized/original byte fraction
(0 < r ≤ 1; successful optimization keeps only the verified output, so
retained managed bytes = `rB`), `T` = retention in months, `f` = retryable
failure rate per job attempt, `n` = jobs per container wake window.

**Infrastructure storage cost, not the customer selling price:**

```
C_direct_storage = B · T · $0.015
C_optimized_storage = rB · T · $0.015
```

These are continuous marginal estimates before provider daily-peak metering,
rounding, and allowances. Customer billing meters retained byte-time, excluding
temporary copies and cleanup delays; its selling rate is not decided here.
If the original is also retained, optimized storage is `(1+r)·B·T·$0.015`.
That is greater than original-only storage: there is no storage-only payback.

**Per-optimization-job marginal cost (our R2 path):**

```
C_job = U·2e-5                                 # CPU, U vCPU-seconds actually used
      + T_run·(8·2.5e-6 + 16·7e-8)             # provisioned mem+disk, standard-3
      + T_do·1.6e-6                            # DO wall-clock (pending I/O counts)
      + A·4.5e-6 + B_ops·3.6e-7                # R2 Class A / Class B ops
      + Q·4e-7                                 # queue ops (≈3 + retries, ≤64 KB)
      + W_req·3e-7 + W_ms·2e-8                 # worker invocations + CPU-ms
      + E·(0.025 … 0.05)                       # outbound container GB; no R2-target exemption established
      + tail/n                                 # idle park share, ≤$0.0127
```

With independent repeat-until-success attempts of equal cost, the illustrative
expected cost is `C_job / (1−f)`. Real retries are bounded and may reuse work;
terminal failures still consume resources. There is no customer optimization fee.
Use measured attempt and failure distributions for internal cost estimates.

**BYOK (customer bucket) marginal cost:**

- Ours: `C_job` with `E = rB` written to the customer endpoint and zero R2 storage.
- Theirs (AWS example): `B` read egress ≈ `B·$0.09` beyond the 100 GB free
  tier + `rB·$0.023·T` storage + ~$0.005/1k PUT; provider-specific table above.
- The Containers rate card does not establish an exemption for writes to R2.
  For managed writes, show network cost as a separate sensitivity and verify
  actual billing before treating that traffic as free. R2's free outbound
  egress does not itself establish free outbound traffic from Containers.

**Savings from optimizing (managed path):**

```
ΔS = (1−r)·B·$0.015   per month of retention    → pays back C_job over T_be = C_job / ΔS
```

For the complete comparison, including the agreed validation-only path:

```
C_direct = C_validation + C_direct_storage + C_direct_ops_and_transfer
C_opt = C_processing + C_optimized_storage + C_opt_ops_and_transfer + C_temporary
T_break_even = incremental_upfront_cost / ((1-r) · B · storage_rate)
```

`incremental_upfront_cost` subtracts the direct path's validation/operations
from the optimized path's cost. This is Meltiply's infrastructure decision,
not a customer optimization purchase. Include transfer and temporary residency;
with `r=1`, there is no storage payback.

## Illustrative break-even examples (assumptions labeled)

Assumed (not measured): ffmpeg/libvips saturate both vCPUs on video, ~50% on
images; cold-start ≈3 s included in T_run; ≤64 KB queue messages; NA/EU egress
where applicable. Figures exclude common validation-only costs, staging,
retained-original time during processing, and additional retry costs.
Included-usage allotments are ignored; see "marginal vs fully allocated" below.
These are scenario estimates, not proof of production savings. For an incremental
comparison, subtract the validation-only baseline from total optimization cost.

**Image.** B = 10 MB, r = 0.30, T_run = 5 s at ~1 vCPU (U = 5 vCPU-s), DO 8 s.

- Compute: CPU $1.0e-4 + mem/disk $1.3e-4 + DO $1.3e-5 + ops ~$5e-6 + queue
  ~$1e-6 ≈ **$0.00025–$0.0004** while packed.
- ΔS = 7 MB × $0.015 = **$0.000105/month** ⇒ T_be ≈ **2.5–4 months** packed
  before output-transfer costs. A 3 MB output adds $0.000075 at $0.025/GB.
  If the job alone bears the 10-min idle park (+$0.0127), payback exceeds
  **10 years** before considering transfer and retries.
- Low-volume images can therefore cost much more to process than they save in
  storage. Actual utilization measurements are needed before claiming cost reduction.

**Video (hypothetical, above the current 500 MiB upload limit).**
B = 1 GB, r = 0.50, T_run = 120 s saturated (U = 240 vCPU-s).
Assume a multipart 0.5 GB output (~55 Class A ops) and DO 125 s;
actual engine write operations must be measured rather than inferred from size.

- Compute: CPU $4.8e-3 + mem/disk $2.5e-3 + DO $2e-4 + ops ~$2.5e-4 ≈
  **$0.0078**; plus up to $0.0127 if it bears the park ⇒ $0.008–$0.020.
- ΔS = 0.5 GB × $0.015 = $0.0075/month ⇒ T_be ≈ **1–3 months** before
  output-transfer costs. If 0.5 GB of container output is billed at $0.025/GB,
  add $0.0125: total ≈$0.020–$0.033, payback ≈**3–4.5 months**.
- **BYOK AWS variant**: customer additionally pays ≈1 GB × $0.09 = $0.09
  source-read egress beyond their free tier. Their storage savings are
  0.5 GB × $0.023 = $0.0115/month; that read alone takes ≈**7.8 months**
  to recover, before other processing costs and provider operations.

## Marginal vs fully allocated

- **Marginal** figures above assume the $5/mo Workers Paid subscription and all
  included allotments are already consumed by the platform — true at scale.
- **Fully allocated / low volume**: monthly allotments cover roughly 3.1
  standard-3 instance-hours of memory (25 GiB-h ÷ 8 GiB — the binding
  allotment), 375 vCPU-min CPU, 200 GB-h disk, 1M queue ops, 10M worker
  requests, 400k DO GB-s. ≈15 sparse video jobs/mo (720 s wake each) could run
  entirely inside the allowance: effective marginal cost $0 until the first
  overage. R2's 10 GB / 1M Class A / 10M Class B free tier likewise absorbs
  early managed storage — but **does not** apply to Infrequent Access.
- Fixed/provisioned exposure: the $5/mo plan; provisioned (not used)
  memory+disk for every second a container is awake, including the 600 s idle
  tail and ~1–3 s cold starts; DO wall-clock while any container RPC is
  pending; `max_instances: 4` bounds worst-case concurrent burn at ~4×$0.22/h.

## Migration: customer bucket → customer bucket or managed R2

Copying `N` objects totaling `B` GB between stores costs, per direction:

```
C_migrate = B·e_src                          # source egress: $0 for R2; AWS ≈$0.09/GB beyond the 100 GB/mo global free tier; B2 free to 3× stored; Wasabi/DO bounded by fair-use / included allowances
          + N·(op_get_src + op_put_dst)      # AWS→anything example: ≈ N·$0.0054/1k ≈ $5.40 per million objects total
          + B·e_cont                         # if a container relays bytes; include outbound transfer unless an exemption is verified
          + B·s_dst·T_overlap                # destination storage during copy/verification overlap
```

Multipart destination writes multiply `op_put_dst` (each `UploadPart` is a
write-class op on both R2 and S3); un-aborted in-progress parts hold billable
storage until `abort()`. Source-object deletion is a free operation on R2 and
S3, but early-deletion penalties apply where the source class has a minimum
storage duration (Wasabi 90-day "timed deleted storage", AWS S3-IA 30-day, DO
Cold 30-day), so post-migration cleanup is not cost-free on those providers.
Writing into R2 incurs no R2 inbound transfer fee; a container relay's outbound
charge must be checked separately. Cloudflare's Super Slurper has no tool fee,
with resulting R2 Class A ops billed and source reads/egress still charged.
This does not establish Super Slurper as the application's migration mechanism.

## Residency, retries, and lifecycle cost traps

- R2 Standard has no minimum duration; transient staging is cheap
  (daily-peak GB-month) and deletes are free — but per the accepted design
  there is **no persistent BYOK staging in our R2**; the 16 GB container disk
  is the workspace (billed while running regardless of use; engine caps keep
  the working set well under it).
- In-progress multipart uploads accrue storage until `abort()`ed; aborted
  uploads are free ops but the already-uploaded `UploadPart` calls were still
  Class A. A cleanup/abort path on job failure is a cost control, not just
  hygiene.
- Queue retries re-bill read ops; DLQ writes bill another op. Container job
  retries consume resources; measured retry and terminal-failure costs belong in the comparison.
- DO duration bills for pending I/O — a hung 9-min job costs ~$0.0009 in DO
  wall-clock on top of saturated container rates; `PROCESSOR_JOB_TIMEOUT_MS`
  caps this.
- Early-deletion economics pass to customers on providers with minimum
  durations (Wasabi 90-day "timed deleted storage"; AWS S3-IA 30-day;
  DO Cold 30-day) — "keep only verified result" overwrites/deletes originals,
  which can trigger those fees on the customer's bill.
- Billable rounding: Cloudflare rounds up per million ops / per GB-month; at
  small volume each rounding boundary is a step in effective unit price.

## Output quality constraints (cost-relevant)

- Compression is constrained by the agreed quality floor. Already efficient
  inputs can yield no smaller acceptable output; the original then remains
  retained, so storage savings are zero despite processing costs.
  Measure this outcome rate alongside successful compression ratios.
- Verification (full decode of output) is billed compute regardless of outcome.
  Failed verification preserves the usable source and still consumes resources.
- Retaining originals alongside outputs increases storage from `B` to `(1+r)B`.
  It eliminates storage-only payback versus retaining the original alone.
  Publication performance or compatibility benefits would need separate justification.

## Measurements needed before real recommendations

1. `r` distribution per asset class/codec on the actual corpus (quality-floor
   pass-through rate `r ≈ 1` frequency).
2. Per-job `U` (vCPU-s), `T_run`, and cold-start share vs the 600 s park; jobs
   per wake `n` under real arrival patterns → true amortized tail cost.
3. Attempt failure rate `f` (decode failures, verification failures, timeouts)
   → measured retry overhead and terminal-failure costs in the internal model.
4. Queue redelivery rate and DLQ rate; message sizes (must stay ≤64 KB).
5. Container scheduling region distribution → applicable egress tier for BYOK
   write-back; measured `rB` egress per job.
6. Multipart part-size choice for writes (Class A op count vs resumability).
7. R2 read pattern during optimization (single GET vs ranged reads) → Class B
   op count.
8. Monthly allotment burn-down across all included dimensions to decide when
   marginal rates actually apply (the $5/mo plan's included usage may cover
   the whole feature at launch volume).

## Sources

- <https://developers.cloudflare.com/r2/pricing/> (updated 2026-10-01)
- <https://developers.cloudflare.com/r2/objects/upload-objects/> (2026-07-29)
- <https://developers.cloudflare.com/workers/platform/pricing/> (2026-10-02)
- <https://developers.cloudflare.com/queues/platform/pricing/> (2026-04-21)
- <https://developers.cloudflare.com/durable-objects/platform/pricing/> (2026-09-30)
- <https://developers.cloudflare.com/containers/> , /platform/pricing/ (2026-10-05),
  /platform/limits/ (2026-09-30), /concepts/architecture/ (2026-09-30)
- <https://aws.amazon.com/s3/pricing/> + AWS Price List API
  `offers/v1.0/aws/AmazonS3/current/us-east-1/index.json` and
  `offers/v1.0/aws/AWSDataTransfer/current/index.json` (retrieved 2026-10-06)
- <https://www.backblaze.com/cloud-storage/pricing>
- <https://wasabi.com/pricing> and <https://wasabi.com/pricing/faq>
- <https://docs.digitalocean.com/products/spaces/details/pricing/> (2026-07-13)
- Repo anchors: `workers/automation/wrangler.jsonc`,
  `workers/automation/processor/Dockerfile`,
  `workers/automation/src/native-processor.ts`
