# Backend benchmark comparison

Baseline: master@d370259ef0c3

Candidate: logic-optimize-39@bfc005fd624a

## Environment and workload

- Environment: linux/x64, Bun 1.4.2
- PostgreSQL: 18.6 (service container), one dedicated database per revision
- Dataset: {"assets":300,"comments":100,"distributionLimit":100,"pageSize":100,"posts":300,"scheduleChannels":20,"schedulePosts":42,"batch_delete_posts_per_sample":[1,5,10,25,50]}
- Configuration: {"batch_sizes":[1,5,10,25,50],"delete_concurrency":4,"delete_samples":5,"delete_warmup":1,"measured_samples":30,"warmup_samples":3}
- Repetitions: 3 baseline runs, 3 candidate runs, alternating order
- Samples per run: 30 measured read/mutation samples after 3 warm-ups; deletion batches use 5 samples after 1 warm-up

## Latency and throughput

| Workflow | Samples (B/C) | p50 B | p50 C | Δ p50 | p95 B | p95 C | Δ p95 | p99 B | p99 C | Δ p99 | Throughput B | Throughput C | Δ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| analytics.summary.year | 90/90 | 14.88 | 10.92 | -26.6% | 17.87 | 13.16 | -26.4% | 21.14 | 16.45 | -22.2% | 65.20 | 89.06 | +36.6% |
| assets.detail | 90/90 | 8.92 | 9.19 | +3.0% | 11.49 | 11.11 | -3.3% | 16.57 | 12.01 | -27.5% | 107.64 | 106.75 | -0.8% |
| assets.upload-session.create | 90/90 | 29.30 | 29.39 | +0.3% | 33.53 | 31.66 | -5.6% | 36.58 | 37.99 | +3.9% | 33.59 | 33.64 | +0.2% |
| assets.upload-session.detail | 90/90 | 14.01 | 12.48 | -10.9% | 17.48 | 16.76 | -4.1% | 23.96 | 19.16 | -20.0% | 68.79 | 76.62 | +11.4% |
| calendar.range | 90/90 | 11.91 | 12.22 | +2.6% | 15.19 | 14.66 | -3.5% | 16.73 | 18.86 | +12.7% | 81.02 | 79.72 | -1.6% |
| distributions.list.page100 | 90/90 | 11.15 | 11.64 | +4.4% | 13.29 | 15.56 | +17.1% | 15.16 | 18.88 | +24.5% | 87.69 | 81.69 | -6.8% |
| inbox.list.page100 | 90/90 | 10.50 | 10.46 | -0.4% | 13.29 | 13.00 | -2.2% | 15.08 | 15.32 | +1.6% | 91.94 | 93.12 | +1.3% |
| posts.create.draft | 90/90 | 18.65 | 16.11 | -13.6% | 20.84 | 18.40 | -11.7% | 23.71 | 21.11 | -11.0% | 52.67 | 61.06 | +15.9% |
| posts.delete.bounded4-per-item-refetch.batch1 | 15/15 | 71.26 | 70.16 | -1.5% | 81.93 | 75.21 | -8.2% | 81.93 | 75.21 | -8.2% | 13.70 | 14.16 | +3.4% |
| posts.delete.bounded4-per-item-refetch.batch10 | 15/15 | 544.89 | 543.22 | -0.3% | 573.09 | 555.14 | -3.1% | 573.09 | 555.14 | -3.1% | 18.25 | 18.42 | +1.0% |
| posts.delete.bounded4-per-item-refetch.batch25 | 15/15 | 1318.39 | 1295.39 | -1.7% | 1346.26 | 1329.94 | -1.2% | 1346.26 | 1329.94 | -1.2% | 18.96 | 19.22 | +1.4% |
| posts.delete.bounded4-per-item-refetch.batch5 | 15/15 | 274.94 | 275.35 | +0.1% | 300.44 | 289.98 | -3.5% | 300.44 | 289.98 | -3.5% | 18.03 | 18.15 | +0.7% |
| posts.delete.bounded4-per-item-refetch.batch50 | 15/15 | 2499.11 | 2493.16 | -0.2% | 2549.17 | 2547.00 | -0.1% | 2549.17 | 2547.00 | -0.1% | 20.03 | 20.03 | +0.0% |
| posts.delete.bounded4-single-refetch.batch1 | 15/15 | 68.69 | 68.65 | -0.1% | 76.75 | 76.07 | -0.9% | 76.75 | 76.07 | -0.9% | 14.29 | 14.41 | +0.8% |
| posts.delete.bounded4-single-refetch.batch10 | 15/15 | 300.64 | 202.42 | -32.7% | 310.17 | 222.44 | -28.3% | 310.17 | 222.44 | -28.3% | 33.24 | 49.04 | +47.5% |
| posts.delete.bounded4-single-refetch.batch25 | 15/15 | 684.95 | 417.30 | -39.1% | 699.63 | 429.70 | -38.6% | 699.63 | 429.70 | -38.6% | 36.55 | 60.09 | +64.4% |
| posts.delete.bounded4-single-refetch.batch5 | 15/15 | 171.88 | 128.83 | -25.0% | 182.49 | 139.20 | -23.7% | 182.49 | 139.20 | -23.7% | 28.80 | 38.49 | +33.6% |
| posts.delete.bounded4-single-refetch.batch50 | 15/15 | 1300.65 | 776.98 | -40.3% | 1353.45 | 858.60 | -36.6% | 1353.45 | 858.60 | -36.6% | 38.24 | 64.02 | +67.4% |
| posts.delete.sequential-per-item-refetch.batch1 | 15/15 | 76.67 | 78.51 | +2.4% | 103.30 | 100.24 | -3.0% | 103.30 | 100.24 | -3.0% | 12.57 | 12.65 | +0.6% |
| posts.delete.sequential-per-item-refetch.batch10 | 15/15 | 711.27 | 715.77 | +0.6% | 728.94 | 764.05 | +4.8% | 728.94 | 764.05 | +4.8% | 14.11 | 13.93 | -1.2% |
| posts.delete.sequential-per-item-refetch.batch25 | 15/15 | 1778.95 | 1782.14 | +0.2% | 1884.10 | 1965.08 | +4.3% | 1884.10 | 1965.08 | +4.3% | 14.01 | 13.66 | -2.4% |
| posts.delete.sequential-per-item-refetch.batch5 | 15/15 | 355.65 | 351.73 | -1.1% | 374.14 | 365.84 | -2.2% | 374.14 | 365.84 | -2.2% | 14.08 | 14.12 | +0.3% |
| posts.delete.sequential-per-item-refetch.batch50 | 15/15 | 3435.95 | 3375.10 | -1.8% | 3517.64 | 3456.14 | -1.7% | 3517.64 | 3456.14 | -1.7% | 14.51 | 14.79 | +1.9% |
| posts.delete.sequential-single-refetch.batch1 | 15/15 | 72.82 | 72.32 | -0.7% | 79.67 | 79.57 | -0.1% | 79.67 | 79.57 | -0.1% | 13.65 | 13.92 | +2.0% |
| posts.delete.sequential-single-refetch.batch10 | 15/15 | 360.70 | 356.75 | -1.1% | 379.10 | 399.54 | +5.4% | 379.10 | 399.54 | +5.4% | 27.64 | 27.57 | -0.3% |
| posts.delete.sequential-single-refetch.batch25 | 15/15 | 842.80 | 815.05 | -3.3% | 863.97 | 1016.08 | +17.6% | 863.97 | 1016.08 | +17.6% | 29.68 | 30.11 | +1.4% |
| posts.delete.sequential-single-refetch.batch5 | 15/15 | 198.01 | 196.89 | -0.6% | 208.92 | 205.37 | -1.7% | 208.92 | 205.37 | -1.7% | 25.08 | 25.43 | +1.4% |
| posts.delete.sequential-single-refetch.batch50 | 15/15 | 1629.30 | 1579.23 | -3.1% | 1716.65 | 1603.41 | -6.6% | 1716.65 | 1603.41 | -6.6% | 30.41 | 31.77 | +4.5% |
| posts.detail.published | 90/90 | 14.03 | 14.36 | +2.4% | 16.21 | 16.78 | +3.5% | 18.66 | 18.66 | +0.0% | 70.45 | 68.26 | -3.1% |
| posts.list.page100 | 90/90 | 22.63 | 21.96 | -3.0% | 48.83 | 26.80 | -45.1% | 106.57 | 30.51 | -71.4% | 36.27 | 44.44 | +22.5% |
| posts.schedule.fanout20 | 90/90 | 47.66 | 47.99 | +0.7% | 52.28 | 52.88 | +1.1% | 57.72 | 62.45 | +8.2% | 20.72 | 20.59 | -0.6% |

## Database and resource use

| Workflow | Statements/op B | Statements/op C | DB ms/op B | DB ms/op C | Response bytes B | Response bytes C | CPU ms/op B | CPU ms/op C | Fixture setup ms total B | Fixture setup ms total C |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| analytics.summary.year | 1.00 | 1.00 | 6.70 | 2.85 | 681.00 | 681.00 | 5.61 | 5.67 | 0 | 0 |
| assets.detail | 1.00 | 1.00 | 1.47 | 1.49 | 494.00 | 494.00 | 3.94 | 4.07 | 0 | 0 |
| assets.upload-session.create | 12.00 | 12.00 | 20.71 | 20.73 | 1050.00 | 1050.00 | 7.07 | 7.23 | 300 | 304 |
| assets.upload-session.detail | 5.00 | 4.00 | 5.88 | 4.47 | 820.00 | 820.00 | 6.04 | 5.57 | 0 | 0 |
| calendar.range | 1.00 | 1.00 | 3.62 | 3.71 | 117504.00 | 117504.00 | 7.99 | 8.23 | 0 | 0 |
| distributions.list.page100 | 1.00 | 1.00 | 2.97 | 3.12 | 73158.00 | 73158.00 | 6.25 | 6.86 | 0 | 0 |
| inbox.list.page100 | 1.00 | 1.00 | 2.56 | 2.50 | 54338.00 | 54338.00 | 5.44 | 5.42 | 0 | 0 |
| posts.create.draft | 11.00 | 7.00 | 10.30 | 7.53 | 394.00 | 394.00 | 6.82 | 6.36 | 255 | 257 |
| posts.delete.bounded4-per-item-refetch.batch1 | 22.00 | 19.00 | 54.71 | 53.72 | 795879.00 | 795879.00 | 40.88 | 40.82 | 132 | 141 |
| posts.delete.bounded4-per-item-refetch.batch10 | 22.00 | 19.00 | 101.80 | 79.64 | 4803314.00 | 3211296.00 | 49.42 | 49.96 | 1013 | 989 |
| posts.delete.bounded4-per-item-refetch.batch25 | 22.00 | 19.00 | 89.81 | 77.65 | 9596491.00 | 8264080.00 | 49.08 | 48.07 | 2467 | 2435 |
| posts.delete.bounded4-per-item-refetch.batch5 | 22.00 | 19.00 | 123.20 | 75.29 | 2400285.00 | 1601070.00 | 43.42 | 44.53 | 527 | 523 |
| posts.delete.bounded4-per-item-refetch.batch50 | 22.00 | 19.00 | 82.64 | 75.20 | 15324062.00 | 14023501.00 | 44.01 | 44.70 | 4815 | 4842 |
| posts.delete.bounded4-single-refetch.batch1 | 22.00 | 19.00 | 51.81 | 51.33 | 795873.00 | 795873.00 | 37.89 | 39.28 | 138 | 128 |
| posts.delete.bounded4-single-refetch.batch10 | 15.70 | 12.70 | 82.82 | 43.63 | 818511.00 | 818511.00 | 12.73 | 12.01 | 975 | 963 |
| posts.delete.bounded4-single-refetch.batch25 | 15.28 | 12.28 | 88.10 | 39.94 | 856281.00 | 856281.00 | 10.60 | 10.36 | 2466 | 2460 |
| posts.delete.bounded4-single-refetch.batch5 | 16.40 | 13.40 | 75.20 | 45.83 | 805921.00 | 805921.00 | 14.57 | 14.80 | 521 | 523 |
| posts.delete.bounded4-single-refetch.batch50 | 15.14 | 12.14 | 88.62 | 39.45 | 919381.00 | 919381.00 | 9.20 | 8.74 | 4769 | 4744 |
| posts.delete.sequential-per-item-refetch.batch1 | 22.00 | 19.00 | 62.20 | 61.13 | 795882.00 | 795882.00 | 48.83 | 49.89 | 156 | 172 |
| posts.delete.sequential-per-item-refetch.batch10 | 22.00 | 19.00 | 53.26 | 54.14 | 8020393.00 | 8020393.00 | 42.01 | 42.66 | 1013 | 1005 |
| posts.delete.sequential-per-item-refetch.batch25 | 22.00 | 19.00 | 54.42 | 56.09 | 18346697.00 | 18346697.00 | 45.24 | 44.99 | 2498 | 2426 |
| posts.delete.sequential-per-item-refetch.batch5 | 22.00 | 19.00 | 53.23 | 53.03 | 3996425.00 | 3996425.00 | 41.54 | 43.57 | 516 | 510 |
| posts.delete.sequential-per-item-refetch.batch50 | 22.00 | 19.00 | 53.10 | 51.51 | 29293367.00 | 29293367.00 | 40.71 | 40.51 | 4834 | 4834 |
| posts.delete.sequential-single-refetch.batch1 | 22.00 | 19.00 | 54.91 | 53.48 | 795879.00 | 795879.00 | 42.69 | 44.45 | 138 | 152 |
| posts.delete.sequential-single-refetch.batch10 | 15.70 | 12.70 | 26.46 | 26.51 | 818571.00 | 818571.00 | 11.98 | 11.47 | 985 | 969 |
| posts.delete.sequential-single-refetch.batch25 | 15.28 | 12.28 | 24.56 | 23.99 | 856431.00 | 856431.00 | 10.12 | 8.26 | 2440 | 2451 |
| posts.delete.sequential-single-refetch.batch5 | 16.40 | 13.40 | 29.10 | 28.62 | 805951.00 | 805951.00 | 14.35 | 13.43 | 524 | 533 |
| posts.delete.sequential-single-refetch.batch50 | 15.14 | 12.14 | 24.14 | 22.61 | 919681.00 | 919681.00 | 8.56 | 8.22 | 4798 | 4790 |
| posts.detail.published | 5.00 | 5.00 | 5.37 | 5.53 | 1798.00 | 1798.00 | 7.26 | 7.03 | 0 | 0 |
| posts.list.page100 | 5.00 | 5.00 | 11.70 | 11.07 | 278590.00 | 278590.00 | 17.84 | 17.62 | 0 | 0 |
| posts.schedule.fanout20 | 15.00 | 15.00 | 38.58 | 38.89 | 16967.00 | 16967.00 | 10.52 | 10.18 | 212 | 211 |

## Limitations

- The benchmark calls the API app in-process instead of deploying a Worker; Cloudflare CPU-time metrics, Queue latency, and network/provider time are unavailable.
- CPU is the whole Node process (`process.cpuUsage`), including fixture-free benchmark driver work; it is directional, not per-request platform CPU.
- RSS/heap measurements are captured around each scenario and are noisy; only peak RSS is meaningful.
- p99 for deletion batches is computed from pooled batch samples, not individual requests; per-request p95 is reported in the raw JSON.
- Publishing Provider HTTP calls, Queues delivery, and Durable Object work are outside this harness; schedule fan-out and outbox writes are measured.

## Raw results

- `docs/benchmarks/results/2026-10-21-backend/baseline-1.json`
- `docs/benchmarks/results/2026-10-21-backend/baseline-2.json`
- `docs/benchmarks/results/2026-10-21-backend/baseline-3.json`
- `docs/benchmarks/results/2026-10-21-backend/candidate-1.json`
- `docs/benchmarks/results/2026-10-21-backend/candidate-2.json`
- `docs/benchmarks/results/2026-10-21-backend/candidate-3.json`

