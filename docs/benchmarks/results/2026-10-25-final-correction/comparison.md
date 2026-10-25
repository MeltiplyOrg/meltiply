# Backend benchmark comparison

Baseline: master@9fc48ba30a13

Candidate: HEAD@961073dbf3c1

## Environment and workload

- Environment: linux/x64, Bun 1.4.2
- PostgreSQL: 18.6 (service container), one dedicated database per revision
- Dataset: {"assets":300,"comments":100,"distributionLimit":100,"pageSize":100,"posts":300,"scheduleChannels":1,"schedulePosts":42,"snapshotsPerDistribution":90,"batch_delete_posts_per_sample":[1,5,10,25,50]}
- Configuration: {"profile":"application","authentication":"signed-jwt-live-session-actor","batch_sizes":[1,5,10,25,50],"delete_concurrency":4,"delete_samples":5,"delete_warmup":1,"measured_samples":30,"warmup_samples":3,"read_concurrency":20,"controlled_provider_delay_ms":100}
- Repetitions: 3 baseline runs, 3 candidate runs, alternating order
- Samples per run: 30 measured read/mutation samples after 3 warm-ups; deletion batches use 5 samples after 1 warm-up

## Latency and throughput

| Workflow                             | Samples (B/C) |   p50 B |   p50 C |  Δ p50 |   p95 B |   p95 C |   Δ p95 |   p99 B |   p99 C |   Δ p99 | Throughput B | Throughput C |       Δ |
| ------------------------------------ | ------------: | ------: | ------: | -----: | ------: | ------: | ------: | ------: | ------: | ------: | -----------: | -----------: | ------: |
| analytics.page.dashboard-and-ranking |         90/90 | 2214.13 | 2039.71 |  -7.9% | 2923.09 | 2316.89 |  -20.7% | 3159.00 | 2668.31 |  -15.5% |         0.86 |         0.96 |  +12.1% |
| analytics.summary.cold-exact-range   |         90/90 |   12.23 |   11.27 |  -7.8% |   63.03 |   13.62 |  -78.4% |  330.53 |   20.58 |  -93.8% |        39.75 |        87.24 | +119.5% |
| analytics.summary.concurrent-cold20  |         90/90 |  146.24 |  116.98 | -20.0% |  166.12 |  132.55 |  -20.2% |  232.96 |  418.90 |  +79.8% |       133.99 |       161.72 |  +20.7% |
| analytics.summary.year               |         90/90 |   12.31 |    7.58 | -38.4% |   19.44 |    9.47 |  -51.3% |   31.60 |   10.78 |  -65.9% |        76.06 |       127.26 |  +67.3% |
| assets.detail                        |         90/90 |   10.99 |    7.32 | -33.4% |   46.14 |    8.46 |  -81.7% |   47.71 |   13.00 |  -72.8% |        49.39 |       133.46 | +170.2% |
| assets.upload-session.detail         |         90/90 |   12.04 |    9.06 | -24.8% |   58.42 |   10.79 |  -81.5% |   60.53 |   25.67 |  -57.6% |        43.12 |       104.88 | +143.2% |
| calendar.range                       |         90/90 |   11.04 |    9.45 | -14.4% |   14.31 |   12.86 |  -10.1% |   27.07 |   13.81 |  -49.0% |        84.23 |       101.69 |  +20.7% |
| distributions.list.page100           |         90/90 |   10.80 |    9.01 | -16.6% |   13.22 |   32.09 | +142.7% |   20.16 |   47.19 | +134.1% |        90.38 |        84.29 |   -6.7% |
| inbox.list.page100                   |         90/90 |   11.38 |    8.07 | -29.1% |   45.35 |   10.09 |  -77.8% |   47.84 |   13.69 |  -71.4% |        48.36 |       120.26 | +148.7% |
| posts.detail.published               |         90/90 |   13.36 |   11.17 | -16.4% |   16.18 |   13.27 |  -18.0% |   30.33 |   15.49 |  -48.9% |        72.15 |        86.35 |  +19.7% |
| posts.list.page100                   |         90/90 |   17.24 |   15.26 | -11.5% |   23.02 |   21.44 |   -6.9% |   56.31 |   24.68 |  -56.2% |        54.54 |        62.56 |  +14.7% |
| requirements.concurrent20            |         90/90 |  198.10 |  202.43 |  +2.2% |  215.57 |  214.28 |   -0.6% |  227.79 |  288.63 |  +26.7% |        99.61 |        97.81 |   -1.8% |
| requirements.sequential              |         90/90 |  111.02 |  109.05 |  -1.8% |  219.46 |  130.99 |  -40.3% |  400.76 |  143.02 |  -64.3% |         8.04 |         9.02 |  +12.3% |

## Database and resource use

| Workflow                             | Statements/op B | Statements/op C | DB ms/op B | DB ms/op C | Response bytes B | Response bytes C | CPU ms/op B | CPU ms/op C | Fixture setup ms total B | Fixture setup ms total C |
| ------------------------------------ | --------------: | --------------: | ---------: | ---------: | ---------------: | ---------------: | ----------: | ----------: | -----------------------: | -----------------------: |
| analytics.page.dashboard-and-ranking |           18.50 |           10.50 |    1173.29 |    1046.35 |         63383.00 |         63383.00 |       14.36 |       10.51 |                        0 |                        0 |
| analytics.summary.cold-exact-range   |           17.00 |           10.00 |       7.84 |       6.95 |           737.00 |           737.00 |        5.14 |        4.50 |                        0 |                        0 |
| analytics.summary.concurrent-cold20  |           17.00 |            9.05 |      34.28 |       9.38 |         14740.00 |         14740.00 |        4.29 |        3.36 |                        0 |                        0 |
| analytics.summary.year               |           17.00 |            9.00 |       7.94 |       3.74 |           737.00 |           737.00 |        6.10 |        4.60 |                        0 |                        0 |
| assets.detail                        |           17.00 |            9.00 |       5.72 |       3.83 |           494.00 |           494.00 |        4.18 |        3.19 |                        0 |                        0 |
| assets.upload-session.detail         |           19.00 |           11.00 |       7.14 |       5.39 |           820.00 |           820.00 |        4.57 |        3.60 |                        0 |                        0 |
| calendar.range                       |           17.00 |            9.00 |       6.90 |       5.38 |        117504.00 |        117504.00 |        5.62 |        5.06 |                        0 |                        0 |
| distributions.list.page100           |           17.00 |            9.00 |       6.37 |       4.87 |         73158.00 |         73158.00 |        5.75 |        4.97 |                        0 |                        0 |
| inbox.list.page100                   |           17.00 |            9.00 |       6.52 |       4.50 |         54338.00 |         54338.00 |        5.29 |        3.80 |                        0 |                        0 |
| posts.detail.published               |           21.00 |           13.00 |       8.73 |       7.02 |          2052.00 |          2052.00 |        5.68 |        5.24 |                        0 |                        0 |
| posts.list.page100                   |           21.00 |           13.00 |      11.52 |       9.85 |        146280.00 |        146280.00 |       11.48 |       11.00 |                        0 |                        0 |
| requirements.concurrent20            |           17.00 |            9.00 |      23.84 |       6.93 |          5060.00 |          5060.00 |        3.74 |        3.05 |                        0 |                        0 |
| requirements.sequential              |           17.00 |            9.00 |       5.51 |       3.88 |           253.00 |           253.00 |        7.59 |        5.26 |                        0 |                        0 |

## Repeated-read work

| Workflow                            | Aggregates/op B | Aggregates/op C | Aggregate DB ms/op B | Aggregate DB ms/op C | Upstream reads/op B | Upstream reads/op C | Request p95 B | Request p95 C |
| ----------------------------------- | --------------: | --------------: | -------------------: | -------------------: | ------------------: | ------------------: | ------------: | ------------: |
| analytics.summary.cold-exact-range  |            1.00 |            1.00 |                 3.18 |                 3.09 |                0.00 |                0.00 |         63.01 |         13.60 |
| analytics.summary.concurrent-cold20 |            1.00 |            0.05 |                 3.83 |                 0.59 |                0.00 |                0.00 |        149.14 |        121.62 |
| analytics.summary.year              |            1.00 |            0.00 |                 3.29 |                 0.00 |                0.00 |                0.00 |         19.41 |          9.43 |
| requirements.concurrent20           |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                0.05 |        198.27 |        201.56 |
| requirements.sequential             |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                1.00 |        219.40 |        130.92 |

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
