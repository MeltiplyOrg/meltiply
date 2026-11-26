import type { CaptureEvent, CaptureResult, CaptureTransport } from "./contracts";
import type { ReportingDestination } from "./configuration";

/** Hard ceiling on the outbound request; well under a Worker's CPU budget. */
export const CAPTURE_TIMEOUT_MILLISECONDS = 3_000;

const statusOk = (status: number) => status >= 200 && status < 300;

export interface PostHogTransportOptions {
  readonly destination: ReportingDestination;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

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
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
        if (statusOk(response.status)) {
          await response.body?.cancel().catch(() => {});
          return { ok: true };
        }
        await response.body?.cancel().catch(() => {});
        return {
          errorCode: `capture_status_${response.status}`,
          ok: false,
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
