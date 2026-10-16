import { pathToFileURL } from "node:url";

const publicRoutes = ["/api/v1/health", "/api/v1/ready"];

/**
 * Rounds a floating point value to two decimal places.
 *
 * @param {number} value - Number to round
 * @returns {number} Rounded number
 */
function rounded(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Computes a given quantile (0 to 1) from an array of numeric sample values.
 *
 * @param {Array<number>} values - Numeric values array
 * @param {number} quantile - Quantile target (e.g., 0.5, 0.95, 0.99)
 * @returns {number} Value at the computed percentile index
 */
export function percentile(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

/**
 * Validates and parses environment configuration for measuring public route baselines.
 *
 * @param {object} [environment=process.env] - Environment variables source
 * @returns {{ baseUrl: URL, samples: number }} Parsed base URL and sample count
 * @throws {TypeError} If base URL or sample count is invalid
 */
export function publicRouteBaselineOptions(environment = process.env) {
  const baseUrl = new URL(environment.MELTIPLY_API_BASE_URL ?? "http://127.0.0.1:8787");
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new TypeError("MELTIPLY_API_BASE_URL must use http or https");
  }
  const samples = Number(environment.MELTIPLY_ROUTE_BASELINE_SAMPLES ?? "100");
  if (!Number.isInteger(samples) || samples < 1 || samples > 10_000) {
    throw new TypeError("MELTIPLY_ROUTE_BASELINE_SAMPLES must be an integer between 1 and 10000");
  }
  return { baseUrl, samples };
}

/**
 * Measures latency percentiles and sequential throughput for a single public HTTP route.
 * Executes an initial warmup request before sampling, ensuring JIT and socket initialization do not skew percentiles.
 *
 * @param {object} options - Options object
 * @param {URL} options.baseUrl - Base API URL
 * @param {typeof fetch} [options.fetchImplementation=fetch] - HTTP fetch implementation
 * @param {() => number} [options.now=() => performance.now()] - High-resolution timestamp provider
 * @param {string} options.route - Relative route path
 * @param {number} options.samples - Number of measured request samples
 * @returns {Promise<{ p50_ms: number, p95_ms: number, p99_ms: number, route: string, samples: number, throughput_rps: number }>} Measured metrics report
 * @throws {Error} If any request returns a non-OK HTTP status
 */
export async function measurePublicRoute({
  baseUrl,
  fetchImplementation = fetch,
  now = () => performance.now(),
  route,
  samples,
}) {
  const url = new URL(route, baseUrl);
  const request = async () => {
    const response = await fetchImplementation(url, {
      signal: AbortSignal.timeout(10_000),
    });
    await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(`${route} returned HTTP ${response.status}`);
    }
  };

  await request();
  const durations = [];
  const startedAt = now();
  for (let sample = 0; sample < samples; sample += 1) {
    const requestStartedAt = now();
    await request();
    durations.push(now() - requestStartedAt);
  }
  const totalMs = now() - startedAt;
  return {
    p50_ms: rounded(percentile(durations, 0.5)),
    p95_ms: rounded(percentile(durations, 0.95)),
    p99_ms: rounded(percentile(durations, 0.99)),
    route,
    samples,
    throughput_rps: rounded(samples / (totalMs / 1_000)),
  };
}

/**
 * Measures performance baselines across canonical public routes (/api/v1/health and /api/v1/ready).
 *
 * @param {object} [options={}] - Options object with environment and fetch overrides
 * @returns {Promise<Array<object>>} Performance reports for each public route
 */
export async function measurePublicRoutes(options = {}) {
  const { baseUrl, samples } = publicRouteBaselineOptions(options.environment);
  const reports = [];
  for (const route of publicRoutes) {
    reports.push(
      await measurePublicRoute({
        baseUrl,
        fetchImplementation: options.fetchImplementation,
        now: options.now,
        route,
        samples,
      }),
    );
  }
  return reports;
}

/**
 * CLI runner that measures public routes and logs results to stdout in line-delimited JSON format.
 *
 * @returns {Promise<void>}
 */
async function main() {
  for (const report of await measurePublicRoutes()) {
    process.stdout.write(`public_route_baseline ${JSON.stringify(report)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
