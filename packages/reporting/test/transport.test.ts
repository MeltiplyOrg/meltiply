import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { reportingConfiguration } from "../src/configuration";
import { CAPTURE_TIMEOUT_MILLISECONDS, createPostHogTransport } from "../src/transport";

/**
 * Controlled PostHog-compatible capture receiver.
 *
 * These cases exercise the real transport against a real socket on loopback: no
 * `fetch` stub and no echoing adapter stands in for the reporting module. The
 * receiver records the bytes the transport actually sent, which is the only
 * evidence that proves the outbound payload and the deployment controls.
 */

interface ReceivedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
}

/** Receiver behaviour for the next requests. */
type ReceiverMode = { kind: "ok" } | { kind: "status"; status: number } | { kind: "hang" };

const receiver = {
  mode: { kind: "ok" } as ReceiverMode,
  requests: [] as ReceivedRequest[],
};

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    receiver.requests.push({
      body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
      headers: request.headers,
      method: request.method ?? "",
      url: request.url ?? "",
    });
    if (receiver.mode.kind === "hang") {
      // Never respond: the transport's abort signal is the only way out.
      return;
    }
    response.writeHead(receiver.mode.kind === "ok" ? 200 : receiver.mode.status, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ status: 1 }));
  });
});

let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Resets recorded requests and the receiver's behaviour. */
function resetReceiver(mode: ReceiverMode = { kind: "ok" }) {
  receiver.mode = mode;
  receiver.requests = [];
}

/** Resolves the destination the transport under test will use. */
function destinationFor(host = origin) {
  const configuration = reportingConfiguration({
    DEPLOYMENT_CATEGORY: "selfhosted",
    REPORTING_POSTHOG_HOST: host,
    REPORTING_POSTHOG_PROJECT_TOKEN: "phc_acceptanceTokenValue123",
  });
  if (!configuration.destination) throw new Error("test destination did not resolve");
  return configuration.destination;
}

const usageEvent = {
  distinctId: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
  event: "meltiply_usage_daily",
  eventUuid: "9c2f1e88-1f77-4f4b-8f11-2a5b7c1d0e22",
  properties: {
    app_version: "1.0.0-target.0",
    channels: { threads: 2 },
    deployment_category: "selfhosted",
    schema_version: 1,
  },
  timestamp: "2026-01-02T00:00:00.000Z",
};

describe("PostHog capture transport", () => {
  it("sends one documented capture request to the configured ingestion path", async () => {
    resetReceiver();
    const transport = createPostHogTransport({ destination: destinationFor() });

    const result = await transport.capture(usageEvent);

    expect(result).toEqual({ ok: true });
    expect(receiver.requests).toHaveLength(1);
    const [captured] = receiver.requests;
    expect(captured!.method).toBe("POST");
    // The capture reference documents `/i/v0/e/`, not `/capture/`.
    expect(captured!.url).toBe("/i/v0/e/");
    expect(captured!.headers["content-type"]).toBe("application/json");
    expect(captured!.body).toMatchObject({
      api_key: "phc_acceptanceTokenValue123",
      distinct_id: usageEvent.distinctId,
      event: "meltiply_usage_daily",
      timestamp: "2026-01-02T00:00:00.000Z",
      uuid: usageEvent.eventUuid,
    });
  });

  it("disables person profiles and geoip without adding identify properties", async () => {
    resetReceiver();
    const transport = createPostHogTransport({ destination: destinationFor() });

    await transport.capture(usageEvent);

    const properties = receiver.requests[0]!.body.properties as Record<string, unknown>;
    expect(properties.$process_person_profile).toBe(false);
    expect(properties.$geoip_disable).toBe(true);
    // No identification or enrichment payload may accompany a report.
    expect(properties.$set).toBeUndefined();
    expect(properties.$set_once).toBeUndefined();
    expect(Object.keys(properties).some((key) => key.startsWith("$group"))).toBe(false);
  });

  it("reports a rejected ingestion as retryable only when the status allows a retry", async () => {
    resetReceiver({ kind: "status", status: 500 });
    const transport = createPostHogTransport({ destination: destinationFor() });
    const upstreamFailure = await transport.capture(usageEvent);
    expect(upstreamFailure).toMatchObject({
      errorCode: "capture_status_500",
      ok: false,
      retryable: true,
    });

    resetReceiver({ kind: "status", status: 401 });
    const rejected = await transport.capture(usageEvent);
    // A wrong token cannot be fixed by retrying; the row must be discarded.
    expect(rejected).toMatchObject({
      errorCode: "capture_status_401",
      ok: false,
      retryable: false,
    });
  });

  it("times out a hanging destination without throwing", async () => {
    resetReceiver({ kind: "hang" });
    const transport = createPostHogTransport({
      destination: destinationFor(),
      timeoutMilliseconds: 150,
    });

    const result = await transport.capture(usageEvent);

    expect(result).toMatchObject({ errorCode: "capture_timeout", ok: false, retryable: true });
  });

  it("resolves a refused connection as a transport failure value", async () => {
    resetReceiver();
    // Port 9 is closed on loopback; nothing listens and no socket is opened
    // outside the machine.
    const transport = createPostHogTransport({
      destination: destinationFor("http://127.0.0.1:9"),
      timeoutMilliseconds: CAPTURE_TIMEOUT_MILLISECONDS,
    });

    const result = await transport.capture(usageEvent);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ retryable: true });
  });

  it("does not follow a redirect that would forward the project token", async () => {
    resetReceiver({ kind: "status", status: 302 });
    const transport = createPostHogTransport({ destination: destinationFor() });

    const result = await transport.capture(usageEvent);

    expect(result).toMatchObject({ errorCode: "capture_status_302", ok: false });
    expect(receiver.requests).toHaveLength(1);
  });
});

describe("reporting configuration", () => {
  it("keeps a missing token or host unavailable instead of guessing a destination", () => {
    expect(reportingConfiguration({}).destination).toBeNull();
    expect(
      reportingConfiguration({ REPORTING_POSTHOG_HOST: "https://us.i.posthog.com" }).destination,
    ).toBeNull();
    expect(
      reportingConfiguration({ REPORTING_POSTHOG_PROJECT_TOKEN: "phc_acceptanceTokenValue123" })
        .destination,
    ).toBeNull();
  });

  it("rejects a non-canonical or plaintext remote host", () => {
    const token = "phc_acceptanceTokenValue123";
    expect(
      reportingConfiguration({
        REPORTING_POSTHOG_HOST: "https://us.i.posthog.com/v1",
        REPORTING_POSTHOG_PROJECT_TOKEN: token,
      }).destination,
    ).toBeNull();
    expect(
      reportingConfiguration({
        REPORTING_POSTHOG_HOST: "http://us.i.posthog.com",
        REPORTING_POSTHOG_PROJECT_TOKEN: token,
      }).destination,
    ).toBeNull();
    expect(
      reportingConfiguration({
        REPORTING_POSTHOG_HOST: "https://user:pass@us.i.posthog.com",
        REPORTING_POSTHOG_PROJECT_TOKEN: token,
      }).destination,
    ).toBeNull();
  });

  it("derives the documented ingestion path from a canonical https origin", () => {
    const configuration = reportingConfiguration({
      REPORTING_POSTHOG_HOST: "https://eu.i.posthog.com",
      REPORTING_POSTHOG_PROJECT_TOKEN: "phc_acceptanceTokenValue123",
    });
    expect(configuration.destination?.captureUrl).toBe("https://eu.i.posthog.com/i/v0/e/");
  });

  it("treats the operator override as a hard off regardless of configuration", () => {
    const configuration = reportingConfiguration({
      REPORTING_FORCED_OFF: "true",
      REPORTING_POSTHOG_HOST: "https://us.i.posthog.com",
      REPORTING_POSTHOG_PROJECT_TOKEN: "phc_acceptanceTokenValue123",
    });
    expect(configuration.forcedOff).toBe(true);
  });
});
