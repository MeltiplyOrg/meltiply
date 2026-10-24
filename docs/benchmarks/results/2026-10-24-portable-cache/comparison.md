# Backend benchmark comparison

Baseline: master@025e1d6e331e

Candidate: HEAD@6884734be553

## Environment and workload

- Environment: linux/x64, Bun 1.4.2
- PostgreSQL: 18.6 (service container), one dedicated database per revision
- Dataset: {"assets":300,"comments":100,"distributionLimit":100,"pageSize":100,"posts":300,"scheduleChannels":1,"schedulePosts":42,"batch_delete_posts_per_sample":[1,5,10,25,50]}
- Configuration: {"profile":"read-cache","batch_sizes":[1,5,10,25,50],"delete_concurrency":4,"delete_samples":5,"delete_warmup":1,"measured_samples":30,"warmup_samples":3,"read_concurrency":20,"controlled_provider_delay_ms":100}
- Repetitions: 3 baseline runs, 3 candidate runs, alternating order
- Samples per run: 30 measured read/mutation samples after 3 warm-ups; deletion batches use 5 samples after 1 warm-up

## Latency and throughput

| Workflow                            | Samples (B/C) |  p50 B |  p50 C |  Δ p50 |  p95 B |  p95 C |  Δ p95 |   p99 B |  p99 C |   Δ p99 | Throughput B | Throughput C |      Δ |
| ----------------------------------- | ------------: | -----: | -----: | -----: | -----: | -----: | -----: | ------: | -----: | ------: | -----------: | -----------: | -----: |
| analytics.summary.cold-exact-range  |         90/90 |   6.30 |   7.10 | +12.7% |   6.87 |   7.93 | +15.4% |    8.41 |  11.45 |  +36.1% |       157.18 |       137.93 | -12.3% |
| analytics.summary.concurrent-cold20 |         90/90 |  95.54 |  94.46 |  -1.1% | 463.72 | 104.25 | -77.5% |  660.14 | 136.98 |  -79.2% |       165.12 |       209.00 | +26.6% |
| analytics.summary.year              |         90/90 |   6.39 |   5.43 | -15.0% |   7.81 |   6.45 | -17.4% |    9.33 |   8.89 |   -4.7% |       153.95 |       181.02 | +17.6% |
| assets.detail                       |         90/90 |   5.20 |   5.27 |  +1.3% |   5.54 |   5.93 |  +7.0% |    6.42 |   6.69 |   +4.2% |       192.56 |       188.04 |  -2.3% |
| assets.upload-session.detail        |         90/90 |   6.69 |   6.74 |  +0.7% |   8.07 |   7.13 | -11.6% |    8.76 |   8.28 |   -5.5% |       146.47 |       147.73 |  +0.9% |
| calendar.range                      |         90/90 |   6.79 |   6.90 |  +1.6% |   8.35 |   8.43 |  +1.0% |   16.52 |  11.86 |  -28.2% |       139.45 |       140.43 |  +0.7% |
| distributions.list.page100          |         90/90 |   6.37 |   6.52 |  +2.4% |   7.38 |   7.90 |  +7.0% |    8.21 |  77.61 | +845.3% |       154.92 |       134.73 | -13.0% |
| inbox.list.page100                  |         90/90 |   5.97 |   6.00 |  +0.5% |   7.49 |   6.49 | -13.4% |    8.72 |   7.60 |  -12.8% |       163.07 |       165.32 |  +1.4% |
| posts.detail.published              |         90/90 |   8.48 |   8.45 |  -0.4% |   9.67 |   9.73 |  +0.6% |   10.27 |  10.74 |   +4.6% |       116.51 |       116.47 |  -0.0% |
| posts.list.page100                  |         90/90 |  11.53 |  11.30 |  -2.0% |  13.82 |  12.81 |  -7.3% |   16.41 |  13.59 |  -17.2% |        85.92 |        88.17 |  +2.6% |
| requirements.concurrent20           |         90/90 | 184.04 | 183.87 |  -0.1% | 196.72 | 193.18 |  -1.8% | 1408.50 | 195.52 |  -86.1% |        99.95 |       108.57 |  +8.6% |
| requirements.sequential             |         90/90 | 105.47 | 105.40 |  -0.1% | 107.31 | 106.81 |  -0.5% |  108.17 | 108.24 |   +0.1% |         9.45 |         9.47 |  +0.2% |

## Database and resource use

| Workflow                            | Statements/op B | Statements/op C | DB ms/op B | DB ms/op C | Response bytes B | Response bytes C | CPU ms/op B | CPU ms/op C | Fixture setup ms total B | Fixture setup ms total C |
| ----------------------------------- | --------------: | --------------: | ---------: | ---------: | ---------------: | ---------------: | ----------: | ----------: | -----------------------: | -----------------------: |
| analytics.summary.cold-exact-range  |            1.00 |            2.00 |       1.67 |       2.43 |           737.00 |           737.00 |        2.37 |        2.77 |                        0 |                        0 |
| analytics.summary.concurrent-cold20 |            1.00 |            1.41 |       5.33 |       5.28 |         14740.00 |         14740.00 |        2.34 |        2.41 |                        0 |                        0 |
| analytics.summary.year              |            1.00 |            1.00 |       1.66 |       0.72 |           737.00 |           737.00 |        3.00 |        2.87 |                        0 |                        0 |
| assets.detail                       |            1.00 |            1.00 |       0.81 |       0.84 |           494.00 |           494.00 |        1.77 |        1.93 |                        0 |                        0 |
| assets.upload-session.detail        |            3.00 |            3.00 |       2.12 |       2.16 |           820.00 |           820.00 |        2.14 |        2.00 |                        0 |                        0 |
| calendar.range                      |            1.00 |            1.00 |       2.05 |       2.04 |        117504.00 |        117504.00 |        4.41 |        4.38 |                        0 |                        0 |
| distributions.list.page100          |            1.00 |            1.00 |       1.62 |       1.71 |         73158.00 |         73158.00 |        3.34 |        3.45 |                        0 |                        0 |
| inbox.list.page100                  |            1.00 |            1.00 |       1.44 |       1.46 |         54338.00 |         54338.00 |        2.66 |        2.70 |                        0 |                        0 |
| posts.detail.published              |            5.00 |            5.00 |       3.54 |       3.53 |          2052.00 |          2052.00 |        3.78 |        3.69 |                        0 |                        0 |
| posts.list.page100                  |            5.00 |            5.00 |       5.53 |       5.40 |        146280.00 |        146280.00 |        7.77 |        7.58 |                        0 |                        0 |
| requirements.concurrent20           |            1.00 |            1.00 |       0.92 |       0.98 |          5060.00 |          5060.00 |        2.23 |        2.18 |                        0 |                        0 |
| requirements.sequential             |            1.00 |            1.00 |       0.35 |       0.37 |           253.00 |           253.00 |        3.42 |        3.17 |                        0 |                        0 |

## Repeated-read work

| Workflow                            | Aggregates/op B | Aggregates/op C | Aggregate DB ms/op B | Aggregate DB ms/op C | Upstream reads/op B | Upstream reads/op C | Request p95 B | Request p95 C |
| ----------------------------------- | --------------: | --------------: | -------------------: | -------------------: | ------------------: | ------------------: | ------------: | ------------: |
| analytics.summary.cold-exact-range  |            1.00 |            1.00 |                 1.67 |                 1.70 |                0.00 |                0.00 |          6.85 |          7.91 |
| analytics.summary.concurrent-cold20 |            1.00 |            0.41 |                 5.33 |                 2.87 |                0.00 |                0.00 |        107.17 |         93.43 |
| analytics.summary.year              |            1.00 |            0.00 |                 1.66 |                 0.00 |                0.00 |                0.00 |          7.79 |          6.44 |
| requirements.concurrent20           |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                0.05 |        184.65 |        181.77 |
| requirements.sequential             |            0.00 |            0.00 |                 0.00 |                 0.00 |                1.00 |                1.00 |        107.27 |        106.78 |

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
