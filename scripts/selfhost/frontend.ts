import frontend from "../../frontend/app/src/worker";
import { errorDiagnostic } from "@meltiply/observability";

type Env = { API: Fetcher; ASSETS: Fetcher; ENVIRONMENT: string; VERSION: string };

export default {
  /** Diagnoses the self-hosted service-binding failure without changing request bodies or authentication. */
  fetch(request: Request, env: Env) {
    return frontend.fetch(request, {
      ...env,
      API: {
        fetch: async (forwarded: Request) => {
          try {
            return await env.API.fetch(forwarded);
          } catch (cause) {
            console.error("[DEBUG-selfhost-proxy]", JSON.stringify(errorDiagnostic(cause)));
            throw cause;
          }
        },
      },
    });
  },
};
