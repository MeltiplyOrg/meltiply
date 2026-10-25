# Backend benchmark comparison

Baseline: master@451c0a224a63

Candidate: HEAD@ea52a6fa2640

## Environment and workload

- Environment: linux/x64, Bun 1.4.2
- PostgreSQL: 18.6 (service container), one dedicated database per revision
- Dataset: {"assets":300,"comments":100,"distributionLimit":100,"pageSize":100,"posts":300,"scheduleChannels":1,"schedulePosts":42,"snapshotsPerDistribution":90,"batch_delete_posts_per_sample":[1,5,10,25,50]}
- Configuration: {"profile":"application","authentication":"signed-jwt-live-session-actor","batch_sizes":[1,5,10,25,50],"delete_concurrency":4,"delete_samples":5,"delete_warmup":1,"measured_samples":10,"warmup_samples":3,"read_concurrency":20,"controlled_provider_delay_ms":100}
- Repetitions: 1 baseline runs, 1 candidate runs, alternating order
- Samples per run: 10 measured read/mutation samples after 3 warm-ups; deletion batches use 5 samples after 1 warm-up

## Latency and throughput

| Workflow                             | Samples (B/C) |   p50 B |   p50 C |   Δ p50 |   p95 B |   p95 C |   Δ p95 |   p99 B |   p99 C |   Δ p99 | Throughput B | Throughput C |      Δ |
| ------------------------------------ | ------------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: | ------: | -----------: | -----------: | -----: |
| analytics.page.dashboard-and-ranking |         10/10 | 3484.45 | 4195.35 |  +20.4% | 3967.43 | 4328.44 |   +9.1% | 3967.43 | 4328.44 |   +9.1% |         0.56 |         0.48 | -15.0% |
| analytics.summary.cold-exact-range   |         10/10 |   16.19 |  108.75 | +571.7% |   17.85 |  117.46 | +558.0% |   17.85 |  117.46 | +558.0% |        60.73 |         9.11 | -85.0% |
| analytics.summary.concurrent-cold20  |         10/10 |  205.19 | 1494.49 | +628.3% |  226.75 | 1535.01 | +577.0% |  226.75 | 1535.01 | +577.0% |        96.28 |        13.35 | -86.1% |
| analytics.summary.year               |         10/10 |   16.87 |   95.63 | +466.9% |   19.85 |   97.98 | +393.6% |   19.85 |   97.98 | +393.6% |        57.68 |        10.44 | -81.9% |
| assets.detail                        |         10/10 |   12.76 |   93.85 | +635.5% |   16.61 |   97.61 | +487.7% |   16.61 |   97.61 | +487.7% |        76.07 |        10.64 | -86.0% |
| assets.upload-session.detail         |         10/10 |   15.18 |  102.40 | +574.6% |   16.49 |  111.97 | +579.0% |   16.49 |  111.97 | +579.0% |        65.31 |         9.59 | -85.3% |
| calendar.range                       |         10/10 |   15.90 |  104.81 | +559.2% |   23.83 |  118.62 | +397.8% |   23.83 |  118.62 | +397.8% |        59.06 |         9.47 | -84.0% |
| distributions.list.page100           |         10/10 |   15.89 |  102.28 | +543.7% |   20.18 |  115.41 | +471.9% |   20.18 |  115.41 | +471.9% |        59.49 |         9.64 | -83.8% |
| inbox.list.page100                   |         10/10 |   13.84 |   99.03 | +615.5% |   15.32 |  102.59 | +569.6% |   15.32 |  102.59 | +569.6% |        70.38 |        10.04 | -85.7% |
| posts.detail.published               |         10/10 |   18.45 |  116.99 | +534.1% |   21.61 |  119.00 | +450.7% |   21.61 |  119.00 | +450.7% |        53.28 |         8.55 | -84.0% |
| posts.list.page100                   |         10/10 |   25.47 |  129.62 | +408.9% |   32.12 |  139.18 | +333.3% |   32.12 |  139.18 | +333.3% |        38.26 |         7.61 | -80.1% |
| requirements.concurrent20            |         10/10 |  235.88 | 1490.64 | +531.9% |  248.30 | 1527.39 | +515.1% |  248.30 | 1527.39 | +515.1% |        84.05 |        13.40 | -84.1% |
| requirements.sequential              |         10/10 |  136.65 |  194.03 |  +42.0% |  526.59 |  200.74 |  -61.9% |  526.59 |  200.74 |  -61.9% |         5.64 |         5.14 |  -8.8% |

## Database and resource use

| Workflow                             | Statements/op B | Statements/op C | DB ms/op B | DB ms/op C | Response bytes B | Response bytes C | CPU ms/op B | CPU ms/op C | Fixture setup ms total B | Fixture setup ms total C |
| ------------------------------------ | --------------: | --------------: | ---------: | ---------: | ---------------: | ---------------: | ----------: | ----------: | -----------------------: | -----------------------: |
| analytics.page.dashboard-and-ranking |           18.50 |           10.50 |    1798.78 |    2343.77 |         63383.00 |         63383.00 |       18.37 |       36.12 |                        0 |                        0 |
| analytics.summary.cold-exact-range   |           17.00 |           10.00 |      10.28 |      60.37 |           737.00 |           737.00 |        7.11 |       25.69 |                        0 |                        0 |
| analytics.summary.concurrent-cold20  |           17.00 |            9.05 |      48.59 |     214.72 |         14740.00 |         14740.00 |        6.72 |       22.71 |                        0 |                        0 |
| analytics.summary.year               |           17.00 |            9.00 |      10.80 |      48.06 |           737.00 |           737.00 |        7.88 |       23.62 |                        0 |                        0 |
| assets.detail                        |           17.00 |            9.00 |       7.44 |      47.95 |           494.00 |           494.00 |        6.44 |       22.01 |                        0 |                        0 |
| assets.upload-session.detail         |           19.00 |           11.00 |       9.46 |      56.61 |           820.00 |           820.00 |        7.12 |       22.39 |                        0 |                        0 |
| calendar.range                       |           17.00 |            9.00 |       9.63 |      54.75 |        117504.00 |        117504.00 |       12.10 |       29.81 |                        0 |                        0 |
| distributions.list.page100           |           17.00 |            9.00 |       9.48 |      54.25 |         73158.00 |         73158.00 |       10.32 |       26.10 |                        0 |                        0 |
| inbox.list.page100                   |           17.00 |            9.00 |       8.43 |      52.24 |         54338.00 |         54338.00 |        7.03 |       23.51 |                        0 |                        0 |
| posts.detail.published               |           21.00 |           13.00 |      11.68 |      66.70 |          2052.00 |          2052.00 |        8.98 |       28.11 |                        0 |                        0 |
| posts.list.page100                   |           21.00 |           13.00 |      16.48 |      74.71 |        146280.00 |        146280.00 |       19.37 |       44.55 |                        0 |                        0 |
| requirements.concurrent20            |           17.00 |            9.00 |      34.10 |     187.58 |          5060.00 |          5060.00 |        6.52 |       21.47 |                        0 |                        0 |
| requirements.sequential              |           17.00 |            9.00 |       8.57 |      45.73 |           253.00 |           253.00 |       10.29 |       24.60 |                        0 |                        0 |

## Repeated-read work

| Workflow                            | Aggregates/op B | Aggregates/op C | Aggregate DB ms/op B | Aggregate DB ms/op C | Upstream reads/op B | Upstream reads/op C | Request p95 B | Request p95 C |
| ----------------------------------- | --------------: | --------------: | -------------------: | -------------------: | ------------------: | ------------------: | ------------: | ------------: |
| analytics.summary.cold-exact-range  |            1.00 |            1.00 |                 4.32 |                11.47 |                0.00 |                0.00 |         17.82 |        117.38 |
| analytics.summary.concurrent-cold20 |            1.00 |            0.05 |                 6.11 |                 3.10 |                0.00 |                0.00 |        205.70 |       1469.68 |
| analytics.summary.year              |            1.00 |            0.00 |                 4.36 |                 0.00 |                0.00 |                0.00 |         19.82 |         97.94 |
| requirements.concurrent20           |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                0.07 |        234.32 |       1461.99 |
| requirements.sequential             |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                1.00 |        526.52 |        200.66 |

## Limitations

- The benchmark calls the API app in-process instead of deploying a Worker; Cloudflare CPU-time metrics, Queue latency, and network/provider time are unavailable.
- CPU is the whole Node process (`process.cpuUsage`), including fixture-free benchmark driver work; it is directional, not per-request platform CPU.
- RSS/heap measurements are captured around each scenario and are noisy; only peak RSS is meaningful.
- p99 for deletion batches is computed from pooled batch samples, not individual requests; per-request p95 is reported in the raw JSON.
- Provider requirements use a controlled adapter with a fixed synthetic delay; its counted reads and latency are not live Provider or network measurements. Publishing, Queue delivery, and Durable Objects remain outside this harness.

## Raw results

- `benchmark-results/baseline-1.json`
- `benchmark-results/candidate-1.json`
