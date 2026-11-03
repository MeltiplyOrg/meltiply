import type { CaptureEvent, CaptureResult, CaptureTransport } from "./contracts";
import type { ReportingDestination } from "./configuration";

/**
 * PostHog Cloud capture adapter.
 *
 * Bounded by design: one POST per event, a hard timeout, a small response read,
 * and no retries of its own (the durable queue owns retry and backoff). Failures
 * are values, never exceptions, so a PostHog outage cannot change an HTTP
 * status, a queue acknowledgment or a scheduled invocation's outcome.
 *
 * The adapter never reports its own failure to PostHog. Recursion is impossible
 * by construction: this module has no dependency on the reporting service and
 * the transport outcome is only logged locally.
 */

/** Hard ceiling on the outbound request; well under a Worker's CPU budget. */
export const CAPTURE_TIMEOUT_MILLISECONDS = 3_000;

/** Responses are not read for content; only the status decides the outcome. */
const statusOk = (status: number) => status >= 200 && status < 300;

export interface PostHogTransportOptions {
  readonly destination: ReportingDestination;
  /** Injectable for tests and for runtimes that need an explicit fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

/**
 * Builds the capture body.
 *
 * `uuid` is PostHog's documented event identity: events sharing `uuid`, `event`,
 * `timestamp` and `distinct_id` are de-duplicated, which is why the frozen
 * UUID and frozen timestamp both travel on every retry of the same report.
 *
 * `$process_person_profile: false` is an explicit request not to create or
 * enrich a person profile. It is a PostHog collection control, not a claim of
 * anonymity: the installation identifier still links one installation's reports
 * over time, which is why the disclosure calls them pseudonymous.
 *
 * @param event - Already allowlisted event, with frozen UUID and timestamp.
 * @param projectToken - Publishable project token.
 * @returns Serialized capture request body.
 */
function captureBody(event: CaptureEvent, projectToken: string): string {
  return JSON.stringify({
    api_key: projectToken,
    distinct_id: event.distinctId,
    event: event.event,
    properties: {
      ...event.properties,
      $geoip_disable: true,
      $process_person_profile: false,
    },
    timestamp: event.timestamp,
    uuid: event.eventUuid,
  });
}

/**
 * Creates the PostHog capture transport for one destination.
 *
 * @param options - Destination, optional fetch implementation and timeout.
 * @returns Transport whose `capture` resolves to a bounded outcome.
 */
export function createPostHogTransport(options: PostHogTransportOptions): CaptureTransport {
  const request = options.fetch ?? fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? CAPTURE_TIMEOUT_MILLISECONDS;
  return {
    async capture(event: CaptureEvent): Promise<CaptureResult> {
      try {
        const response = await request(options.destination.captureUrl, {
          body: captureBody(event, options.destination.projectToken),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          // The timeout is enforced by the abort signal; redirects are not
          // followed so a misconfigured host cannot forward the token elsewhere.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
        // PostHog replies 200 with `{status: 1}`; anything outside 2xx, including
        // a 3xx from a moved host, is a failed delivery.
        if (statusOk(response.status)) {
          await response.body?.cancel().catch(() => {});
          return { ok: true };
        }
        await response.body?.cancel().catch(() => {});
        return {
          errorCode: `capture_status_${response.status}`,
          ok: false,
          // 429 and 5xx are transient; other 4xx means the destination or token
          // is wrong and retrying would only burn the pending window.
          retryable: response.status === 429 || response.status >= 500,
        };
      } catch (cause) {
        const aborted =
          cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
        return {
          errorCode: aborted ? "capture_timeout" : "capture_transport_error",
          ok: false,
          retryable: true,
        };
      }
    },
  };
}
