import type { Platform } from "@meltiply/domain";

import { ProviderHttpClient } from "./http";
import { exactRedirectUri, required } from "./values";

const clientIdMaxChars = 255;

export interface ProviderAdapterOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
}

export interface AdapterRuntime {
  clientId: string;
  clientSecret: string;
  http: ProviderHttpClient;
  now: () => Date;
  redirectUri: string;
}

/** Validates app credentials and builds the platform's allowlisted HTTP client. */
export function adapterRuntime(
  platform: Platform,
  allowedOrigins: readonly string[],
  options: ProviderAdapterOptions,
): AdapterRuntime {
  const now = options.now ?? (() => new Date());
  return {
    clientId: required("clientId", options.clientId, clientIdMaxChars),
    clientSecret: required("clientSecret", options.clientSecret),
    http: new ProviderHttpClient({
      allowedOrigins,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      now,
      platform,
      ...(options.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.timeoutMilliseconds }),
    }),
    now,
    redirectUri: exactRedirectUri(options.redirectUri),
  };
}
