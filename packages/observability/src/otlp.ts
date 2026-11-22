import { sanitizeRecord } from "./log";

const traceIdPattern = /^[0-9a-f]{32}$/;
const nonHexPattern = /[^0-9a-f]/g;
const spanIdPattern = /^[0-9a-f]{16}$/i;

export interface OtlpSpanInput {
  attributes?: Record<string, unknown>;
  endTimeMs: number;
  name: string;
  parentSpanId?: string;
  service: string;
  spanId?: string;
  startTimeMs: number;
  status: "error" | "ok";
  traceId: string;
}

function hash32(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function toTraceIdHex(traceId: string): string {
  const clean = traceId.replaceAll("-", "").toLowerCase();
  if (traceIdPattern.test(clean)) return clean;
  const base = hash32(traceId).toString(16).padStart(8, "0");
  return (base + clean + "0".repeat(32)).replace(nonHexPattern, "0").slice(0, 32);
}

function toSpanIdHex(value: string): string {
  if (spanIdPattern.test(value)) return value.toLowerCase();
  return hash32(value).toString(16).padStart(16, "0").slice(0, 16);
}

function otlpValue(value: unknown) {
  if (typeof value === "number") return { intValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "object" && value !== null) return { stringValue: JSON.stringify(value) };
  return { stringValue: String(value ?? "") };
}

function unixNanoseconds(milliseconds: number): string {
  return String(BigInt(Math.floor(milliseconds)) * 1_000_000n);
}

/**
 * Best-effort OTLP/HTTP export of one span to the local Tempo receiver; a no-op outside the
 * `local` and `test` environments. Attributes are sanitized like log context.
 */
export async function exportOtlpSpan(
  env: { ENVIRONMENT: string },
  span: OtlpSpanInput,
): Promise<void> {
  if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") return;

  const attributes = Object.entries(sanitizeRecord(span.attributes ?? {})).map(([key, value]) => ({
    key,
    value: otlpValue(value),
  }));
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: span.service } },
            { key: "deployment.environment", value: { stringValue: env.ENVIRONMENT } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "meltiply-tracer" },
            spans: [
              {
                attributes,
                endTimeUnixNano: unixNanoseconds(span.endTimeMs),
                kind: 1,
                name: span.name,
                parentSpanId: span.parentSpanId ? toSpanIdHex(span.parentSpanId) : undefined,
                spanId: toSpanIdHex(span.spanId ?? `${span.name}-${span.startTimeMs}`),
                startTimeUnixNano: unixNanoseconds(span.startTimeMs),
                status: { code: span.status === "ok" ? 1 : 2 },
                traceId: toTraceIdHex(span.traceId),
              },
            ],
          },
        ],
      },
    ],
  };

  await fetch("http://127.0.0.1:4318/v1/traces", {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => undefined);
}
