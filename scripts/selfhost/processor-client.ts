import { z } from "zod";
import {
  PROCESSOR_CONTAINER_TIMEOUT_MS,
  validateJob,
  type NativeProcessorJob,
  type MediaProcessorRpcOutcome,
} from "../../workers/automation/src/native-processor";

const successSchema = z.object({
  engine: z.object({ duration_ms: z.number(), ffmpeg: z.string(), vips: z.string() }),
  input: z.object({ bytes: z.number(), sha256: z.string() }),
  job_id: z.string(),
  media: z.object({
    animated: z.boolean(),
    content_type: z.string(),
    duration_seconds: z.number().nullable(),
    frame_count: z.number().nullable(),
    has_audio: z.boolean(),
    height: z.number().nullable(),
    width: z.number().nullable(),
  }),
  output: z
    .object({
      bytes: z.number(),
      content_type: z.string(),
      etag: z.string().nullable(),
      sha256: z.string(),
    })
    .nullable(),
  replayed: z.boolean().optional(),
  result: z.enum(["optimized", "original_compatible"]),
});
const failureSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
});

/**
 * Sends a validated job to the private native engine on port 8082. Validates
 * responses before normalizing HTTP into RPC outcomes; transport or malformed
 * responses remain retryable engine failures. The token is never logged.
 */
export async function processNativeJob(
  job: NativeProcessorJob,
  token: string,
): Promise<MediaProcessorRpcOutcome> {
  const invalid = validateJob(job);
  if (invalid)
    return { ok: false, error: { code: "invalid_request", message: invalid, retryable: false } };
  try {
    const response = await fetch("http://127.0.0.1:8082/process", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(PROCESSOR_CONTAINER_TIMEOUT_MS),
    });
    const payload: unknown = await response.json();
    if (!response.ok) return { ok: false, error: failureSchema.parse(payload).error };
    return { ok: true, result: { ...successSchema.parse(payload), status: "succeeded" } };
  } catch {
    return {
      ok: false,
      error: {
        code: "engine_error",
        message: "The self-hosted processor could not complete the job.",
        retryable: true,
      },
    };
  }
}
