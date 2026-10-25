# Backend benchmark comparison

Baseline: master@9fc48ba30a13

Candidate: HEAD@6216a8fb5814

## Environment and workload

- Environment: linux/x64, Bun 1.4.2
- PostgreSQL: 18.6 (service container), one dedicated database per revision
- Dataset: {"assets":300,"comments":100,"distributionLimit":100,"pageSize":100,"posts":300,"scheduleChannels":1,"schedulePosts":42,"snapshotsPerDistribution":90,"batch_delete_posts_per_sample":[1,5,10,25,50]}
- Configuration: {"profile":"application","authentication":"signed-jwt-live-session-actor","batch_sizes":[1,5,10,25,50],"delete_concurrency":4,"delete_samples":5,"delete_warmup":1,"measured_samples":30,"warmup_samples":3,"read_concurrency":20,"controlled_provider_delay_ms":100}
- Repetitions: 3 baseline runs, 3 candidate runs, alternating order
- Samples per run: 30 measured read/mutation samples after 3 warm-ups; deletion batches use 5 samples after 1 warm-up

## Latency and throughput

| Workflow                             | Samples (B/C) |   p50 B |   p50 C |  Δ p50 |   p95 B |   p95 C |  Δ p95 |   p99 B |   p99 C |  Δ p99 | Throughput B | Throughput C |      Δ |
| ------------------------------------ | ------------: | ------: | ------: | -----: | ------: | ------: | -----: | ------: | ------: | -----: | -----------: | -----------: | -----: |
| analytics.page.dashboard-and-ranking |         90/90 | 1946.02 | 2188.56 | +12.5% | 3086.71 | 3433.41 | +11.2% | 3161.95 | 3550.70 | +12.3% |         0.92 |         0.81 | -12.5% |
| analytics.summary.cold-exact-range   |         90/90 |   10.50 |    8.84 | -15.8% |   13.21 |   12.89 |  -2.4% |   27.55 |   13.16 | -52.2% |        94.37 |        99.58 |  +5.5% |
| analytics.summary.concurrent-cold20  |         90/90 |  126.03 |   98.21 | -22.1% |  592.25 |  117.46 | -80.2% |  886.48 |  123.37 | -86.1% |       119.93 |       197.12 | +64.4% |
| analytics.summary.year               |         90/90 |   10.61 |    6.69 | -36.9% |   12.02 |    8.89 | -26.0% |   25.54 |   10.64 | -58.3% |        92.17 |       141.74 | +53.8% |
| assets.detail                        |         90/90 |    7.97 |    6.66 | -16.4% |    9.75 |    8.57 | -12.1% |   11.05 |    9.33 | -15.6% |       120.09 |       147.66 | +23.0% |
| assets.upload-session.detail         |         90/90 |    9.48 |    8.28 | -12.7% |   11.72 |    9.50 | -18.9% |   13.38 |   10.32 | -22.9% |       101.38 |       120.36 | +18.7% |
| calendar.range                       |         90/90 |    9.71 |    8.35 | -14.0% |   12.01 |   11.03 |  -8.2% |   26.43 |   12.08 | -54.3% |        99.80 |       113.81 | +14.0% |
| distributions.list.page100           |         90/90 |    9.53 |    7.83 | -17.8% |   12.64 |   11.05 | -12.6% |   42.76 |   12.13 | -71.6% |        97.80 |       118.87 | +21.6% |
| inbox.list.page100                   |         90/90 |    8.99 |    7.84 | -12.8% |   11.05 |    9.94 | -10.0% |   15.38 |   10.75 | -30.1% |       108.07 |       125.79 | +16.4% |
| posts.detail.published               |         90/90 |   11.70 |   10.22 | -12.6% |   14.13 |   12.57 | -11.0% |   25.87 |   14.65 | -43.4% |        84.30 |        95.30 | +13.1% |
| posts.list.page100                   |         90/90 |   15.34 |   14.76 |  -3.8% |   20.95 |   19.26 |  -8.1% |   26.62 |   22.87 | -14.1% |        63.85 |        67.37 |  +5.5% |
| requirements.concurrent20            |         90/90 |  184.74 |  185.75 |  +0.5% |  265.28 |  200.33 | -24.5% |  302.46 |  264.96 | -12.4% |       102.61 |       105.54 |  +2.9% |
| requirements.sequential              |         90/90 |  109.41 |  107.87 |  -1.4% |  121.37 |  109.52 |  -9.8% |  461.56 |  110.44 | -76.1% |         8.58 |         9.28 |  +8.2% |

## Database and resource use

| Workflow                             | Statements/op B | Statements/op C | DB ms/op B | DB ms/op C | Response bytes B | Response bytes C | CPU ms/op B | CPU ms/op C | Fixture setup ms total B | Fixture setup ms total C |
| ------------------------------------ | --------------: | --------------: | ---------: | ---------: | ---------------: | ---------------: | ----------: | ----------: | -----------------------: | -----------------------: |
| analytics.page.dashboard-and-ranking |           18.50 |           10.50 |    1089.48 |    1364.63 |         63383.00 |         63383.00 |       12.49 |       10.83 |                        0 |                        0 |
| analytics.summary.cold-exact-range   |           17.00 |           10.00 |       6.66 |       6.13 |           737.00 |           737.00 |        4.07 |        3.60 |                        0 |                        0 |
| analytics.summary.concurrent-cold20  |           17.00 |            9.05 |      34.06 |       8.15 |         14740.00 |         14740.00 |        3.73 |        3.01 |                        0 |                        0 |
| analytics.summary.year               |           17.00 |            9.00 |       6.60 |       3.37 |           737.00 |           737.00 |        4.70 |        4.34 |                        0 |                        0 |
| assets.detail                        |           17.00 |            9.00 |       4.78 |       3.34 |           494.00 |           494.00 |        3.48 |        2.62 |                        0 |                        0 |
| assets.upload-session.detail         |           19.00 |           11.00 |       6.04 |       4.70 |           820.00 |           820.00 |        3.69 |        2.75 |                        0 |                        0 |
| calendar.range                       |           17.00 |            9.00 |       5.87 |       4.82 |        117504.00 |        117504.00 |        4.59 |        4.82 |                        0 |                        0 |
| distributions.list.page100           |           17.00 |            9.00 |       5.54 |       4.41 |         73158.00 |         73158.00 |        5.12 |        4.60 |                        0 |                        0 |
| inbox.list.page100                   |           17.00 |            9.00 |       5.44 |       4.21 |         54338.00 |         54338.00 |        4.37 |        3.50 |                        0 |                        0 |
| posts.detail.published               |           21.00 |           13.00 |       7.38 |       6.28 |          2052.00 |          2052.00 |        4.95 |        4.95 |                        0 |                        0 |
| posts.list.page100                   |           21.00 |           13.00 |      10.02 |       9.06 |        146280.00 |        146280.00 |       10.22 |       10.46 |                        0 |                        0 |
| requirements.concurrent20            |           17.00 |            9.00 |      20.28 |       5.99 |          5060.00 |          5060.00 |        3.11 |        2.66 |                        0 |                        0 |
| requirements.sequential              |           17.00 |            9.00 |       4.56 |       3.20 |           253.00 |           253.00 |        6.18 |        4.67 |                        0 |                        0 |

## Repeated-read work

| Workflow                            | Aggregates/op B | Aggregates/op C | Aggregate DB ms/op B | Aggregate DB ms/op C | Upstream reads/op B | Upstream reads/op C | Request p95 B | Request p95 C |
| ----------------------------------- | --------------: | --------------: | -------------------: | -------------------: | ------------------: | ------------------: | ------------: | ------------: |
| analytics.summary.cold-exact-range  |            1.00 |            1.00 |                 2.78 |                 2.70 |                0.00 |                0.00 |         13.16 |         12.85 |
| analytics.summary.concurrent-cold20 |            1.00 |            0.05 |                 3.29 |                 0.50 |                0.00 |                0.00 |        292.51 |        102.68 |
| analytics.summary.year              |            1.00 |            0.00 |                 2.71 |                 0.00 |                0.00 |                0.00 |         11.99 |          8.84 |
| requirements.concurrent20           |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                0.05 |        203.36 |        187.39 |
| requirements.sequential             |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                1.00 |        121.35 |        109.45 |

## Limitations

- The benchmark calls the API app in-process instead of deploying a Worker; Cloudflare CPU-time metrics, Queue latency, and network/provider time are unavailable.
- CPU is the whole Node process (`process.cpuUsage`), including fixture-free benchmark driver work; it is directional, not per-request platform CPU.
- RSS/heap measurements are captured around each scenario and are noisy; only peak RSS is meaningful.
- p99 for deletion batches is computed from pooled batch samples, not individual requests; per-request p95 is reported in the raw JSON.
- Provider requirements use a controlled adapter with a fixed synthetic delay; its counted reads and latency are not live Provider or network measurements. Publishing, Queue delivery, and Durable Objects remain outside this harness.

## Raw results

- `benchmark-results/baseline-1.json`
- `benchmark-results/baseline-2.json`
- `benchmark-results/baseline-3.json`
- `benchmark-results/candidate-1.json`
- `benchmark-results/candidate-2.json`
- `benchmark-results/candidate-3.json`
