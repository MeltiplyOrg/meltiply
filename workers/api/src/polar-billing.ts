import { ProviderHttpClient } from "@meltiply/providers";

import type { BillingSessionProvider } from "./billing-service";
import { type ApiWorkerEnv, isPolarProductId, polarBillingConfiguration } from "./env";

const hostedBillingOrigins: Record<string, true> = {
  "polar.sh": true,
  "sandbox.polar.sh": true,
};
const portalReplayLifetimeMilliseconds = 5 * 60 * 1_000;

interface PolarBillingProviderOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

interface PolarCheckoutResponse {
  expires_at?: unknown;
  url?: unknown;
}

interface PolarCustomerSessionResponse {
  customer_portal_url?: unknown;
}

/**
 * Constructs standard HTTP request headers for communicating with the Polar REST API.
 *
 * Sets Bearer authorization, `application/json` content type, and passes the operation ID
 * as an `Idempotency-Key` to guarantee idempotent API operations on Polar.
 *
 * @param accessToken - Polar organization API token.
 * @param operationId - Unique operation ID used for request idempotency.
 * @returns HeadersInit dictionary for fetch calls.
 */
function requestHeaders(accessToken: string, operationId: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Idempotency-Key": operationId,
  };
}

/**
 * Validates and sanitizes a hosted URL returned by Polar (checkout or portal).
 *
 * Guarantees the URL uses HTTPS, targets an approved Polar domain (`polar.sh` or `sandbox.polar.sh`),
 * contains no embedded user credentials, and underwent no URL canonicalization mutations.
 *
 * @param value - Candidate URL value from Polar API response.
 * @param object - Descriptive noun for error reporting (e.g., `"checkout session"`).
 * @returns Sanitized and verified URL string.
 * @throws {TypeError} If the URL is missing, malformed, non-HTTPS, or points to an unauthorized host.
 */
function hostedUrl(value: unknown, object: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Polar returned an invalid ${object}`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !hostedBillingOrigins[url.hostname] ||
    url.username ||
    url.password ||
    url.toString() !== value
  ) {
    throw new TypeError(`Polar returned an unsafe ${object} URL`);
  }
  return value;
}

/**
 * Validates that an ISO expiration string returned by Polar is valid and strictly in the future.
 *
 * @param value - Candidate timestamp value from Polar API response.
 * @param now - Current reference timestamp.
 * @returns Canonical ISO 8601 date-time string.
 * @throws {TypeError} If the timestamp is non-string, invalid, or expired.
 */
function expiry(value: unknown, now: Date): string {
  if (typeof value !== "string") {
    throw new TypeError("Polar returned an invalid checkout expiry");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new TypeError("Polar returned an invalid checkout expiry");
  }
  return date.toISOString();
}

/**
 * Creates a Polar-backed `BillingSessionProvider` using environment configuration.
 *
 * Resolves credentials and product identifiers from worker environment variables. If configuration
 * is incomplete or disabled, returns `undefined`. Instantiates a `ProviderHttpClient` with origin
 * enforcement, response size limits, and timeout protection for upstream Polar API communication.
 *
 * @param env - Worker environment bindings.
 * @param options - Optional overrides for fetch implementation and reference clock (used in testing).
 * @returns Initialized `BillingSessionProvider` interface implementation, or `undefined` if unconfigured.
 */
export function createPolarBillingProviderFromEnvironment(
  env: ApiWorkerEnv,
  options: PolarBillingProviderOptions = {},
): BillingSessionProvider | undefined {
  const configured = polarBillingConfiguration(env);
  if (!configured) return undefined;
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [configured.apiBase],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maximumResponseBytes: 64 * 1024,
    now,
    timeoutMilliseconds: 15_000,
  });

  const request = async <T>(
    path: string,
    operationId: string,
    body: Record<string, unknown>,
  ): Promise<T> =>
    (
      await http.request<T>(
        { operationId, requestId: operationId },
        {
          body: JSON.stringify(body),
          headers: requestHeaders(configured.accessToken, operationId),
          method: "POST",
          sideEffectPossible: true,
          url: `${configured.apiBase}${path}`,
        },
      )
    ).body;

  return {
    /**
     * Resolves the configured Polar product ID corresponding to the requested subscription tier.
     *
     * @param input - Plan request object containing the target subscription plan name.
     * @returns Object containing the upstream Polar product ID.
     * @throws {TypeError} If no Polar product ID is configured for the requested tier.
     */
    checkoutPlan({ plan }) {
      const providerPlanId =
        plan === "creator"
          ? configured.creatorProductId
          : plan === "agency"
            ? configured.agencyProductId
            : undefined;
      if (!providerPlanId) {
        throw new TypeError("Polar checkout plan is unavailable");
      }
      return { providerPlanId };
    },

    /**
     * Resolves the stable external customer identity for the organization.
     *
     * In Polar, `external_customer_id` maps directly to Meltiply's organization UUID.
     *
     * @param input - Customer input containing the Meltiply organization ID.
     * @returns Object containing the provider customer ID (equal to organization ID).
     */
    async ensureCustomer({ organizationId }) {
      // Polar treats external_customer_id as the stable customer identity and
      // creates or links the customer during checkout. No synthetic provider ID
      // is needed; the organization ID is the documented external identifier.
      return { providerCustomerId: organizationId };
    },

    /**
     * Creates an upstream Polar checkout session for subscription purchasing.
     *
     * Posts checkout configuration with customer metadata and return URLs, validating the
     * returned hosted URL and expiration timestamp.
     *
     * @param input - Checkout session parameters including plan, URLs, and operation ID.
     * @returns Hosted checkout URL and ISO expiration timestamp.
     * @throws {TypeError} If plan evidence is invalid or Polar returns an unsafe URL or expiry.
     */
    async createCheckoutSession(input) {
      if (!input.providerPlanId || !isPolarProductId(input.providerPlanId)) {
        throw new TypeError("Polar checkout plan evidence is invalid");
      }
      const response = await request<PolarCheckoutResponse>("/v1/checkouts/", input.operationId, {
        customer_metadata: {
          meltiply_organization_id: input.organizationId,
        },
        external_customer_id: input.providerCustomerId,
        metadata: {
          meltiply_organization_id: input.organizationId,
          meltiply_plan: input.plan,
        },
        products: [input.providerPlanId],
        return_url: input.cancelUrl,
        success_url: input.successUrl,
      });
      return {
        expires_at: expiry(response.expires_at, now()),
        url: hostedUrl(response.url, "checkout session"),
      };
    },

    /**
     * Creates an upstream Polar customer portal session for subscription management.
     *
     * Generates a short-lived link enabling customer self-service billing management in Polar.
     *
     * @param input - Portal session parameters including customer ID, return URL, and operation ID.
     * @returns Hosted portal URL and ISO expiration timestamp.
     */
    async createPortalSession(input) {
      const response = await request<PolarCustomerSessionResponse>(
        "/v1/customer-sessions/",
        input.operationId,
        {
          external_customer_id: input.providerCustomerId,
          return_url: input.returnUrl,
        },
      );
      return {
        expires_at: new Date(now().getTime() + portalReplayLifetimeMilliseconds).toISOString(),
        url: hostedUrl(response.customer_portal_url, "customer session"),
      };
    },
  };
}
