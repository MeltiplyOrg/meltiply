// Disposable smoke entry only; production Worker entries never import this file.
import { ProviderHttpClient, ProviderRegistry } from "@meltiply/providers";
import { z } from "zod";
import type { Hono } from "hono";
import { createApiApp } from "../src/app";
import { CoreApiError } from "../src/core-types";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../src/env";

interface RequirementsSmokeEnv extends ApiWorkerEnv {
  REQUIREMENTS_UPSTREAM: Fetcher;
  SMOKE_SUBJECT: string;
  SMOKE_EMAIL: string;
}

const requirementsSchema = z.object({
  commentAllowed: z.boolean(),
  creatorAvatarUrl: z.string(),
  creatorDisplayName: z.string(),
  creatorUsername: z.string(),
  duetAllowed: z.boolean(),
  maxVideoDurationSeconds: z.number(),
  platform: z.literal("tiktok"),
  privacyLevels: z.array(z.literal("PUBLIC_TO_EVERYONE")),
  stitchAllowed: z.boolean(),
});
let app: Hono<ApiWorkerEnvironment> | undefined;

export default {
  /**
   * Dispatches independently arriving HTTP requests through real actor resolution, RLS,
   * credential decryption and the production route. Only JWT verification and the external
   * Provider are controlled; the bounded Provider HTTP client still owns deadlines and decoding.
   * The one registry is deployment-owned, so requests can share pending work, not request resources.
   */
  fetch(
    request: Request,
    env: RequirementsSmokeEnv,
    ctx: ExecutionContext,
  ): Promise<Response> | Response {
    if (!app) {
      const registry = new ProviderRegistry();
      const capability = registry
        .capabilities()
        .find((candidate) => candidate.platform === "tiktok");
      if (!capability) throw new Error("TikTok capability fixture is missing");
      const http = new ProviderHttpClient({
        allowedOrigins: ["https://controlled-requirements.test"],
        fetch: (input, init) => env.REQUIREMENTS_UPSTREAM.fetch(input, init),
      });
      registry.register("tiktok", {
        capability,
        transferModes: [],
        getPublicationRequirements: async (context) => {
          const response = await http.request<unknown>(context, {
            url: "https://controlled-requirements.test/requirements",
            method: "GET",
            headers: { "X-Request-ID": context.requestId },
          });
          return requirementsSchema.parse(response.body);
        },
      });
      app = createApiApp({
        providerRegistry: registry,
        verifyJwtToken: async (_bindings, token) => {
          if (token !== "controlled-requirements-smoke") {
            throw new CoreApiError(401, "unauthorized", "Invalid smoke identity");
          }
          return { subject: env.SMOKE_SUBJECT, email: env.SMOKE_EMAIL, emailVerified: true };
        },
      });
    }
    return app.fetch(request, env, ctx);
  },
};
