import { describe, expect, it, vi } from "vite-plus/test";

import type { ApiWorkerEnv } from "../src/env";
import { createPolarBillingProviderFromEnvironment } from "../src/polar-billing";

const now = new Date("2026-07-22T12:00:00.000Z");
const creatorProductId = "11111111-1111-4111-8111-111111111111";
const agencyProductId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const env = {
  ALLOWED_ORIGINS: "https://app.example.com",
  ENVIRONMENT: "test",
  POLAR_ACCESS_TOKEN: "polar_oat_testtoken12345",
  POLAR_AGENCY_PRODUCT_ID: agencyProductId,
  POLAR_CREATOR_PRODUCT_ID: creatorProductId,
  POLAR_ENV: "sandbox",
  VERSION: "test",
} satisfies ApiWorkerEnv;

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function requestBody(
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  index: number,
): Record<string, unknown> {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return JSON.parse(String(body)) as Record<string, unknown>;
}

describe("Polar billing provider", () => {
  it("fails closed unless complete distinct product configuration is present", () => {
    expect(
      createPolarBillingProviderFromEnvironment({
        ALLOWED_ORIGINS: "https://app.example.com",
        ENVIRONMENT: "test",
        VERSION: "test",
      }),
    ).toBeUndefined();
    expect(
      createPolarBillingProviderFromEnvironment({
        ...env,
        POLAR_AGENCY_PRODUCT_ID: undefined,
      }),
    ).toBeUndefined();
    expect(
      createPolarBillingProviderFromEnvironment({
        ...env,
        POLAR_AGENCY_PRODUCT_ID: creatorProductId,
      }),
    ).toBeUndefined();
    expect(
      createPolarBillingProviderFromEnvironment({
        ...env,
        POLAR_ACCESS_TOKEN: "not-a-polar-token",
      }),
    ).toBeUndefined();
  });

  it("uses external organization identity for checkout and customer portal", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          expires_at: "2026-07-22T12:30:00.000Z",
          url: "https://sandbox.polar.sh/checkout/test-session",
        }),
      )
      .mockResolvedValueOnce(
        json({
          customer_portal_url: "https://sandbox.polar.sh/customer-portal/test-session",
        }),
      );
    const provider = createPolarBillingProviderFromEnvironment(env, {
      fetch: fetcher,
      now: () => now,
    })!;

    await expect(
      provider.ensureCustomer({
        operationId: "billing-customer:organization",
        organizationId,
      }),
    ).resolves.toEqual({ providerCustomerId: organizationId });
    await expect(
      provider.createCheckoutSession({
        cancelUrl: "https://app.example.com/billing?checkout=cancelled",
        operationId: "billing-checkout:stable-operation",
        organizationId,
        plan: "creator",
        providerIntentCreatedAt: now.toISOString(),
        providerCustomerId: organizationId,
        providerPlanId: creatorProductId,
        successUrl: "https://app.example.com/billing?billing=pending",
      }),
    ).resolves.toEqual({
      expires_at: "2026-07-22T12:30:00.000Z",
      url: "https://sandbox.polar.sh/checkout/test-session",
    });
    await expect(
      provider.createPortalSession({
        operationId: "billing-portal:stable-operation",
        organizationId,
        providerCustomerId: organizationId,
        returnUrl: "https://app.example.com/billing",
      }),
    ).resolves.toEqual({
      expires_at: "2026-07-22T12:05:00.000Z",
      url: "https://sandbox.polar.sh/customer-portal/test-session",
    });

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "https://sandbox-api.polar.sh/v1/checkouts/",
      "https://sandbox-api.polar.sh/v1/customer-sessions/",
    ]);
    const checkoutHeaders = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(checkoutHeaders.get("Authorization")).toBe("Bearer polar_oat_testtoken12345");
    expect(checkoutHeaders.get("Content-Type")).toBe("application/json");
    expect(checkoutHeaders.get("Idempotency-Key")).toBe("billing-checkout:stable-operation");
    expect(requestBody(fetcher, 0)).toEqual({
      customer_metadata: { meltiply_organization_id: organizationId },
      external_customer_id: organizationId,
      metadata: {
        meltiply_organization_id: organizationId,
        meltiply_plan: "creator",
      },
      products: [creatorProductId],
      return_url: "https://app.example.com/billing?checkout=cancelled",
      success_url: "https://app.example.com/billing?billing=pending",
    });
    expect(requestBody(fetcher, 1)).toEqual({
      external_customer_id: organizationId,
      return_url: "https://app.example.com/billing",
    });
  });

  it("maps agency product IDs and rejects unsafe provider responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        expires_at: "2026-07-22T12:30:00.000Z",
        url: "https://attacker.example/checkout/stolen",
      }),
    );
    const provider = createPolarBillingProviderFromEnvironment(env, {
      fetch: fetcher,
      now: () => now,
    })!;
    expect(provider.checkoutPlan?.({ plan: "agency" })).toEqual({
      providerPlanId: agencyProductId,
    });
    await expect(
      provider.createCheckoutSession({
        cancelUrl: "https://app.example.com/billing",
        operationId: "billing-checkout:unsafe-url",
        organizationId,
        plan: "agency",
        providerIntentCreatedAt: now.toISOString(),
        providerCustomerId: organizationId,
        providerPlanId: agencyProductId,
        successUrl: "https://app.example.com/billing?billing=pending",
      }),
    ).rejects.toThrow("unsafe checkout session URL");
  });

  it("rejects malformed and oversized responses", async () => {
    const malformed = createPolarBillingProviderFromEnvironment(env, {
      fetch: vi.fn<typeof fetch>(async () => json({ url: "not-a-date" })),
      now: () => now,
    })!;
    await expect(
      malformed.createCheckoutSession({
        cancelUrl: "https://app.example.com/billing",
        operationId: "billing-checkout:malformed",
        organizationId,
        plan: "creator",
        providerIntentCreatedAt: now.toISOString(),
        providerCustomerId: organizationId,
        providerPlanId: creatorProductId,
        successUrl: "https://app.example.com/billing?billing=pending",
      }),
    ).rejects.toThrow("invalid checkout expiry");

    const oversized = createPolarBillingProviderFromEnvironment(env, {
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array(64 * 1024 + 1), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
      now: () => now,
    })!;
    await expect(
      oversized.createCheckoutSession({
        cancelUrl: "https://app.example.com/billing",
        operationId: "billing-checkout:oversized",
        organizationId,
        plan: "creator",
        providerIntentCreatedAt: now.toISOString(),
        providerCustomerId: organizationId,
        providerPlanId: creatorProductId,
        successUrl: "https://app.example.com/billing?billing=pending",
      }),
    ).rejects.toMatchObject({
      failure: { classification: "ambiguous", retryable: false },
    });
  });
});
