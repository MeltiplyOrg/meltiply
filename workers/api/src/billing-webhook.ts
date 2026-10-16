import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import { PLAN_LIMITS, type DatabaseError } from "@meltiply/domain";

import { CoreApiError } from "./core-types";
import { RFC4122_UUID_PATTERN as uuid, sha256Hex } from "./crypto";
import { withSystemTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { lockOrganizationEffect } from "./organization-lock";

const signatureToleranceSeconds = 5 * 60;
const webhookId = /^[A-Za-z0-9_-]{1,255}$/;

type BillingStatus = "active" | "cancelled" | "past_due" | "trialing";

interface PolarEvent {
  data: Record<string, unknown>;
  type: string;
}

interface NormalizedBillingEvent {
  billingStatus: BillingStatus;
  cancelAt: string | null;
  occurredAt: string;
  organizationId: string;
  plan: string;
  renewsAt: string | null;
}

let cachedWebhookSecret: string | undefined;
let cachedWebhookKey: Promise<CryptoKey> | undefined;

/**
 * Imports and caches the HMAC SHA-256 CryptoKey for verifying Polar webhook signatures.
 *
 * Reuses the CryptoKey across requests within an isolate as long as the secret does not change.
 *
 * @param secret - Raw Polar webhook secret string.
 * @returns CryptoKey instance authorized for HMAC verification.
 */
function webhookKey(secret: string): Promise<CryptoKey> {
  if (!cachedWebhookKey || cachedWebhookSecret !== secret) {
    cachedWebhookSecret = secret;
    cachedWebhookKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"],
    );
  }
  return cachedWebhookKey;
}

/**
 * Decodes a base64 string into a Uint8Array byte buffer.
 *
 * Validates base64 length, padding, and characters before decoding via `atob`.
 *
 * @param value - Base64 encoded string.
 * @returns Decoded byte array, or `undefined` if formatting or decoding fails.
 */
function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (value.length < 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Parses and validates Polar standard webhook signature headers.
 *
 * Extracts webhook ID (`webhook-id`), UNIX epoch timestamp (`webhook-timestamp`), and parses
 * versioned `v1,...` signature tokens (`webhook-signature`), decoding each signature into bytes.
 *
 * @param idHeader - Value of `webhook-id` header.
 * @param timestampHeader - Value of `webhook-timestamp` header.
 * @param signatureHeader - Value of `webhook-signature` header.
 * @returns Parsed id, signatures, and timestamp, or `undefined` if validation fails.
 */
function signatureParts(
  idHeader: string | null,
  timestampHeader: string | null,
  signatureHeader: string | null,
): { id: string; signatures: Uint8Array<ArrayBuffer>[]; timestamp: number } | undefined {
  if (
    !idHeader ||
    !webhookId.test(idHeader) ||
    !timestampHeader ||
    !/^\d{1,12}$/.test(timestampHeader) ||
    !signatureHeader ||
    signatureHeader.length > 4_096
  ) {
    return undefined;
  }
  const timestamp = Number(timestampHeader);
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const token of signatureHeader.trim().split(/\s+/)) {
    const separator = token.indexOf(",");
    if (separator < 1 || token.slice(0, separator) !== "v1") continue;
    const signature = bytesFromBase64(token.slice(separator + 1));
    if (signature) signatures.push(signature);
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length < 1 || signatures.length > 5) {
    return undefined;
  }
  return { id: idHeader, signatures, timestamp };
}

/**
 * Verifies a Polar webhook HMAC-SHA256 signature against the raw payload and headers.
 *
 * Checks that the timestamp is within 5 minutes of `now` and validates the HMAC digest across
 * the message formatted as `${webhook_id}.${webhook_timestamp}.${rawBody}`.
 *
 * @param secret - Polar webhook signing secret.
 * @param rawBody - Raw unparsed HTTP request body string.
 * @param headers - HTTP request headers containing `webhook-id`, `webhook-timestamp`, and `webhook-signature`.
 * @param now - Reference timestamp to check for clock drift/replay attacks.
 * @returns The verified webhook ID and timestamp, or `undefined` if invalid or out of tolerance.
 */
async function verifyPolarSignature(
  secret: string,
  rawBody: string,
  headers: Headers,
  now: Date,
): Promise<{ id: string; timestamp: number } | undefined> {
  const parsed = signatureParts(
    headers.get("webhook-id"),
    headers.get("webhook-timestamp"),
    headers.get("webhook-signature"),
  );
  if (
    !parsed ||
    Math.abs(Math.floor(now.getTime() / 1_000) - parsed.timestamp) > signatureToleranceSeconds
  ) {
    return undefined;
  }
  const key = await webhookKey(secret);
  const payload = new TextEncoder().encode(`${parsed.id}.${parsed.timestamp}.${rawBody}`);
  for (const signature of parsed.signatures) {
    if (await crypto.subtle.verify("HMAC", key, signature, payload)) {
      return { id: parsed.id, timestamp: parsed.timestamp };
    }
  }
  return undefined;
}

/**
 * Validates that an unknown value is a non-null, non-array object dictionary.
 *
 * @param value - Candidate input value.
 * @returns Object dictionary, or `undefined` if primitive, array, or null.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extracts the target organization UUID from Polar event metadata or customer objects.
 *
 * Checks top-level metadata, nested customer metadata, and customer `external_id`.
 *
 * @param object - Polar event data payload object.
 * @returns Organization UUID string if found, otherwise `undefined`.
 */
function metadataOrganizationId(object: Record<string, unknown>): string | undefined {
  const direct = record(object.metadata);
  const directId = direct?.meltiply_organization_id ?? direct?.organization_id;
  if (typeof directId === "string") return directId;

  const customer = record(object.customer);
  const customerMetadata = record(customer?.metadata);
  const customerId =
    customerMetadata?.meltiply_organization_id ?? customerMetadata?.organization_id;
  if (typeof customerId === "string") return customerId;
  return typeof customer?.external_id === "string" ? customer.external_id : undefined;
}

/**
 * Collects all product IDs associated with a Polar subscription event.
 *
 * Scans direct `product_id`, nested `product.id`, and `price.product_id`.
 *
 * @param object - Polar subscription event data payload object.
 * @returns Array of product ID strings.
 */
function productIds(object: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const direct = object.product_id;
  if (typeof direct === "string") ids.push(direct);
  const product = record(object.product);
  if (typeof product?.id === "string") ids.push(product.id);
  const price = record(object.price);
  if (typeof price?.product_id === "string") ids.push(price.product_id);
  return ids;
}

/**
 * Maps Polar product identifiers found in the event payload to an internal plan tier.
 *
 * Compares against configured environment product IDs (`POLAR_CREATOR_PRODUCT_ID` and
 * `POLAR_AGENCY_PRODUCT_ID`). Ensures unambiguous mapping (returns undefined if multiple plans match).
 *
 * @param env - Worker environment bindings.
 * @param object - Polar subscription event payload object.
 * @returns `"creator"`, `"agency"`, or `undefined` if unmapped.
 */
function planFor(env: ApiWorkerEnv, object: Record<string, unknown>): string | undefined {
  const plans = new Set<string>();
  for (const productId of productIds(object)) {
    if (productId === env.POLAR_CREATOR_PRODUCT_ID?.trim()) plans.add("creator");
    if (productId === env.POLAR_AGENCY_PRODUCT_ID?.trim()) plans.add("agency");
  }
  return plans.size === 1 ? [...plans][0] : undefined;
}

/**
 * Normalizes upstream Polar subscription status strings into internal `BillingStatus` values.
 *
 * Maps `"canceled"`, `"revoked"`, `"paused"` to `"cancelled"`, and `"incomplete"` to `"past_due"`.
 *
 * @param value - Candidate status string from Polar.
 * @returns Normalized `BillingStatus` union value, or `undefined` if unrecognized.
 */
function billingStatus(value: unknown): BillingStatus | undefined {
  if (value === "trialing" || value === "active" || value === "past_due") {
    return value;
  }
  if (value === "incomplete") return "past_due";
  if (value === "canceled" || value === "cancelled" || value === "revoked" || value === "paused") {
    return "cancelled";
  }
  return undefined;
}

/**
 * Normalizes unknown timestamp values (UNIX epoch seconds or ISO strings) into ISO 8601 strings.
 *
 * @param value - Candidate timestamp input.
 * @returns ISO 8601 date string, or `null` if absent or invalid.
 */
function timestamp(value: unknown): string | null {
  const date =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? new Date(value * 1_000)
      : typeof value === "string" && value.trim()
        ? new Date(value)
        : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Parses and validates the raw JSON payload as a Polar webhook event.
 *
 * @param rawBody - Raw HTTP request body string.
 * @returns Verified `PolarEvent` structure containing data dictionary and event type.
 * @throws {CoreApiError} 400 `invalid_webhook` if parsing fails or structure is invalid.
 */
function polarEvent(rawBody: string): PolarEvent {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const event = record(parsed);
    const data = record(event?.data);
    if (
      !event ||
      !data ||
      typeof event.type !== "string" ||
      event.type.length < 1 ||
      event.type.length > 255
    ) {
      throw new TypeError();
    }
    return { data, type: event.type };
  } catch {
    throw new CoreApiError(
      400,
      "invalid_webhook",
      "The billing webhook body must be a valid Polar event.",
    );
  }
}

/**
 * Normalizes an incoming Polar subscription event into internal billing state fields.
 *
 * Validates clock skew against tolerance, verifies UUID organization ID, matches plan against
 * `PLAN_LIMITS`, and extracts renewal and cancellation timestamps.
 *
 * @param env - Worker environment bindings.
 * @param event - Parsed Polar webhook event.
 * @param occurredAt - ISO timestamp when the event occurred.
 * @param now - Reference timestamp for clock skew checking.
 * @returns `NormalizedBillingEvent` with organization ID, plan, status, and dates, or `undefined` if ignored.
 */
function normalizePolarEvent(
  env: ApiWorkerEnv,
  event: PolarEvent,
  occurredAt: string,
  now: Date,
): NormalizedBillingEvent | undefined {
  const object = event.data;
  const organizationId = metadataOrganizationId(object)?.trim();
  const plan = planFor(env, object);
  if (
    new Date(occurredAt).getTime() > now.getTime() + signatureToleranceSeconds * 1_000 ||
    !organizationId ||
    !uuid.test(organizationId) ||
    !plan
  ) {
    return undefined;
  }

  const subscriptionEvents = [
    "subscription.active",
    "subscription.created",
    "subscription.updated",
    "subscription.uncanceled",
    "subscription.resumed",
    "subscription.canceled",
    "subscription.paused",
    "subscription.revoked",
    "subscription.past_due",
  ];
  if (!subscriptionEvents.includes(event.type)) return undefined;

  const status = ["subscription.canceled", "subscription.paused", "subscription.revoked"].includes(
    event.type,
  )
    ? "cancelled"
    : billingStatus(object.status);
  if (!status || !Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan)) {
    return undefined;
  }

  const currentPeriodEnd = timestamp(object.current_period_end);
  const cancelAt =
    timestamp(object.ends_at) ??
    (object.cancel_at_period_end === true ? currentPeriodEnd : null) ??
    (status === "cancelled" ? timestamp(object.canceled_at) : null);
  return {
    billingStatus: status,
    cancelAt,
    occurredAt,
    organizationId,
    plan,
    renewsAt: status === "cancelled" ? null : currentPeriodEnd,
  };
}

/**
 * Finalizes the webhook event row in `webhook_events` with the designated outcome.
 *
 * @param client - Active Effect transaction client inside the caller's transaction.
 * @param eventId - Unique Polar webhook ID.
 * @param outcome - Processing outcome (`"processed"` or `"ignored"`).
 * @returns Effect resolving when the ledger row is updated.
 */
function finish(
  client: EffectTransactionClient,
  eventId: string,
  outcome: "processed" | "ignored",
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      "UPDATE webhook_events SET outcome = $2, processed_at = now(), updated_at = now() WHERE provider = 'billing' AND event_id = $1",
      [eventId, outcome],
    )
    .pipe(Effect.asVoid);
}

/**
 * Validates, deduplicates, and processes an incoming Polar billing webhook event.
 *
 * Verifies the HMAC-SHA256 signature, claims the event in `webhook_events` to prevent replay,
 * acquires an organization lock, and updates organization plan/subscription details if the event
 * timestamp is newer than any previously applied billing event (`billing_event_at`).
 * The returned Effect is executed once by the route boundary (runRouteEffect).
 *
 * @param env - Worker environment bindings containing `BILLING_WEBHOOK_SECRET` and product IDs.
 * @param rawBody - Raw HTTP request body string.
 * @param headers - HTTP request headers containing Polar signature headers.
 * @param dependencies - Optional clock override for deterministic time verification in tests.
 * @returns Effect resolving to whether the event was ignored or replayed.
 * Fails with {CoreApiError} 503 `billing_unavailable` if webhook secret is not configured,
 * 401 `invalid_webhook_signature` if signature fails verification, or
 * 409 `webhook_replay_mismatch` if event ID was seen with different payload.
 */
export function handleBillingWebhook(
  env: ApiWorkerEnv,
  rawBody: string,
  headers: Headers,
  dependencies: { now?: () => Date } = {},
): Effect.Effect<{ ignored: boolean; replayed: boolean }, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const secret = env.BILLING_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return yield* Effect.fail(
        new CoreApiError(
          503,
          "billing_unavailable",
          "Billing webhook verification is not configured.",
        ),
      );
    }
    const now = dependencies.now?.() ?? new Date();
    const verified = yield* Effect.tryPromise({
      catch: (cause) =>
        cause instanceof CoreApiError
          ? cause
          : new CoreApiError(
              401,
              "invalid_webhook_signature",
              "The billing webhook signature is invalid.",
            ),
      try: () => verifyPolarSignature(secret, rawBody, headers, now),
    });
    if (!verified) {
      return yield* Effect.fail(
        new CoreApiError(
          401,
          "invalid_webhook_signature",
          "The billing webhook signature is invalid.",
        ),
      );
    }
    const event = yield* Effect.try({
      catch: (cause) =>
        cause instanceof CoreApiError
          ? cause
          : new CoreApiError(
              400,
              "invalid_request",
              cause instanceof Error ? cause.message : "The billing webhook payload is invalid.",
            ),
      try: () => polarEvent(rawBody),
    });
    const hash = yield* Effect.tryPromise({
      catch: (cause) =>
        new CoreApiError(
          500,
          "internal_error",
          cause instanceof Error ? cause.message : "Hashing failed.",
        ),
      try: () => sha256Hex(rawBody),
    });
    return yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        const inserted = yield* client.query(
          "INSERT INTO webhook_events (provider, event_id, event_type, payload_hash) VALUES ('billing', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id",
          [verified.id, event.type, hash],
        );
        if (inserted.rowCount !== 1) {
          const existing = yield* client.query<{
            outcome: string;
            payload_hash: string;
          }>(
            "SELECT payload_hash, outcome FROM webhook_events WHERE provider = 'billing' AND event_id = $1",
            [verified.id],
          );
          if (existing.rows[0]?.payload_hash !== hash) {
            return yield* Effect.fail(
              new CoreApiError(
                409,
                "webhook_replay_mismatch",
                "The billing event ID was replayed with a different payload.",
              ),
            );
          }
          return {
            ignored: existing.rows[0]?.outcome === "ignored",
            replayed: true,
          };
        }

        const occurredAt = new Date(verified.timestamp * 1_000).toISOString();
        const normalized = normalizePolarEvent(env, event, occurredAt, now);
        if (!normalized) {
          yield* finish(client, verified.id, "ignored");
          return { ignored: true, replayed: false };
        }
        yield* lockOrganizationEffect(client, normalized.organizationId);
        const updated = yield* client.query(
          `UPDATE organizations
           SET plan = $2,
               billing_status = $3,
               renews_at = $4,
               cancel_at = $5,
               billing_event_at = $6,
               updated_at = now()
           WHERE id = $1
             AND (billing_event_at IS NULL OR billing_event_at < $6)
           RETURNING id`,
          [
            normalized.organizationId,
            normalized.plan,
            normalized.billingStatus,
            normalized.renewsAt,
            normalized.cancelAt,
            normalized.occurredAt,
          ],
        );
        if (updated.rowCount !== 1) {
          yield* finish(client, verified.id, "ignored");
          return { ignored: true, replayed: false };
        }
        yield* finish(client, verified.id, "processed");
        return { ignored: false, replayed: false };
      }),
    );
  });
}
