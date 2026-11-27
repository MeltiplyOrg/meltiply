import { isLocalOrTestEnvironment } from "./log";
import { otlpTracePayload, type OtlpSpanInput } from "./otlp-payload";

export type { OtlpSpanInput } from "./otlp-payload";

/**
 * Best-effort OTLP/HTTP export of one span to the local Tempo receiver; a no-op outside the
 * `local` and `test` environments. Attributes are sanitized like log context.
 */
export async function exportOtlpSpan(
  env: { ENVIRONMENT: string },
  span: OtlpSpanInput,
): Promise<void> {
  if (!isLocalOrTestEnvironment(env.ENVIRONMENT)) return;

  await fetch("http://127.0.0.1:4318/v1/traces", {
    body: JSON.stringify(otlpTracePayload(env.ENVIRONMENT, span)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => undefined);
}
