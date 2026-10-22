# Backend benchmark

Reproducible, evidence-first measurement of the API Worker's core backend
workflows. The runner builds the real Hono app and services in-process against
a dedicated PostgreSQL database, times each workflow through the same service
or route the product uses, and emits JSON that the comparison script turns into
a before/after report.

Current results and analysis:
[backend performance comparison](../../../docs/benchmarks/backend-optimization.md).

## What it measures

| Workflow                             | Path                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `posts.list.page100`                 | `GET /api/v1/posts?limit=100&offset=0`                   |
| `posts.detail.published`             | `GET /api/v1/posts/:id`                                  |
| `distributions.list.page100`         | `GET /api/v1/distributions?limit=100&offset=0`           |
| `calendar.range`                     | `GET /api/v1/calendar?start=…&end=…`                     |
| `analytics.summary.year`             | `GET /api/v1/analytics?start=…&end=…` (366-day maximum)  |
| `inbox.list.page100`                 | `GET /api/v1/inbox?limit=100&offset=0`                   |
| `assets.detail`                      | `GET /api/v1/assets/:id`                                 |
| `assets.upload-session.detail`       | `GET /api/v1/asset-upload-sessions/:id`                  |
| `posts.create.draft`                 | `POST /api/v1/posts` (text-only draft)                   |
| `posts.schedule.fanout20`            | `POST /api/v1/posts/:id/schedule` with 20 saved Channels |
| `posts.schedule.drop19`              | Reschedule 20 Channels down to one, cancelling 19        |
| `assets.upload-session.create`       | `POST /api/v1/asset-upload-sessions` (single PUT)        |
| `posts.delete.*.batch{1,5,10,25,50}` | `DELETE /api/v1/posts/:id` under four execution modes    |

Deletion modes isolate the two costs in the user-visible path:

- `sequential-per-item-refetch`: baseline UI behavior — one delete at a time,
  then refetch Posts, Distributions, and Calendar after every success.
- `sequential-single-refetch`: sequential deletes with one refetch after the
  batch.
- `bounded4-per-item-refetch`: four concurrent deletes, refetch after each.
- `bounded4-single-refetch`: four concurrent deletes, one refetch after the
  batch.

Each deletable Post owns one Asset attachment, two scheduled Distributions with
pending outbox commands, and one published Distribution that deletion must not
touch.

## Metrics

Every scenario records:

- latency p50/p95/p99/mean/min/max over measured samples;
- per-request latency samples (deletion batches);
- throughput (operations per second);
- HTTP response bytes;
- application SQL statement count per operation, statement-time percentiles,
  total statement time, and the most repeated statements;
- process CPU and RSS/heap around the measured operation only; fixture setup
  time is reported separately as `setup_ms_total`.

Unavailable metrics are stated in the comparison report: deployed Worker CPU
time, Queue delivery, provider HTTP time, and Durable Object work are outside
this harness.

## Local run

Start the local PostgreSQL container, then recreate the benchmark database from
the current checkout's migrations:

```sh
bun run db:start
BENCHMARK_DATABASE_NAME=meltiply_benchmark bun run benchmark:prepare
```

Database preparation accepts only `localhost`, `127.0.0.1`, or `::1` by default,
including PostgreSQL's effective query-string `host` override. An empty host
cannot fall through to `PGHOST`. Set `BENCHMARK_ALLOW_REMOTE_DATABASE=1` only
for an isolated, disposable remote benchmark server: preparation drops and
recreates the benchmark database and changes fixture role credentials. Database
names must still start with `meltiply_bench`.

Run the harness:

```sh
BENCHMARK_DATABASE_AUTHENTICATED_URL='postgres://meltiply_rls:meltiply-authenticated-local@127.0.0.1:5433/meltiply_benchmark?sslmode=disable' \
BENCHMARK_DATABASE_SYSTEM_URL='postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply_benchmark?sslmode=disable' \
BENCHMARK_LABEL=local BENCHMARK_OUTPUT_FILE=/tmp/meltiply-benchmark/local.json \
bun run benchmark:backend
```

Configuration:

| Variable                          | Default        | Meaning                                             |
| --------------------------------- | -------------- | --------------------------------------------------- |
| `BENCHMARK_SAMPLES`               | `20`           | Measured samples for read/mutation workflows        |
| `BENCHMARK_WARMUP`                | `3`            | Warm-up samples before measurement                  |
| `BENCHMARK_DELETE_SAMPLES`        | `3`            | Measured batches per delete mode                    |
| `BENCHMARK_DELETE_WARMUP`         | `1`            | Warm-up batches per delete mode                     |
| `BENCHMARK_DELETE_BATCH_SIZES`    | `1,5,10,25,50` | Batch sizes                                         |
| `BENCHMARK_DELETE_CONCURRENCY`    | `4`            | Bounded deletion concurrency                        |
| `BENCHMARK_ALLOW_ERRORS`          | unset          | Exit zero despite scenario errors                   |
| `BENCHMARK_ALLOW_REMOTE_DATABASE` | `0`            | Set exactly `1` to permit a remote preparation host |

The dataset is fixed in [`fixtures.mjs`](fixtures.mjs): one Workspace, one Brand
Profile, 40 Channels, 300 Posts with attachments and published Distributions,
300 analytics snapshots, 100 comments, and 42 drafts with 20 saved targets.
Deletion fixtures are created per sample. Every run deletes and recreates its
Workspace, so repeated runs are independent.

The `posts.schedule.drop19` scenario runs after fan-out and reuses the last
seeded schedule Post. Before every sample it restores all 20 targets through the
API outside measurement, then times retaining one queued Distribution and
cancelling the other 19. Its SQL count includes the complete scheduling request,
not just cancellation and command cleanup.

## Revisions and comparison

The GitHub workflow `.github/workflows/backend-benchmark.yml` checks out
`master` as the baseline and the dispatched commit as the candidate, installs
each with the locked dependency graph, copies this harness into the baseline
checkout, and gives each revision its own migrated database.
Runs alternate baseline/candidate order by repetition; the workflow uses three
repetitions, 30 read/mutation samples, and five samples per deletion batch. Raw JSON and the
Markdown report are uploaded as artifacts.

The harness may only use APIs present in both revisions. It is intentionally
coupled to `workers/api/src` behavior, not to any optimization added on the
candidate.

Before pooling samples, the comparator requires every baseline and candidate
run to match the first baseline's `config`, `dataset`, and sorted workflow names.
Object-key and workflow ordering do not matter; configuration array values and
their order do. The two sides may have different repetition counts. A mismatch
identifies the side, run number, and metadata field, exits nonzero, and writes
neither comparison output.

```sh
bun run benchmark:compare -- \
  --baseline results/baseline-1.json --baseline results/baseline-2.json \
  --candidate results/candidate-1.json --candidate results/candidate-2.json \
  --out results/comparison.md --json results/comparison.json
```

## Limitations

- In-process Hono invocation: no Worker isolate, Cloudflare CPU accounting, TLS,
  or network.
- A single Node process and one PostgreSQL instance; CPU is process-wide.
- RSS/heap deltas are noisy. Peak RSS is reported for context only.
- p99 uses pooled samples across repetitions; deletion per-request p95 is
  available in the raw JSON.
- Provider publishing, Queue delivery, and Durable Objects need separate
  infrastructure and are reviewed but not timed here.
