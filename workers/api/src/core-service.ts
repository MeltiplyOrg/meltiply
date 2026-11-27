import type { components } from "@meltiply/contracts/schema";
import { ProviderRegistry } from "@meltiply/providers";

import { createAnalyticsMethods, mapSnapshot } from "./analytics-service";
export { mapSnapshot };
import type { CoreApiService } from "./core-types";
import { withTenantTransactionEffect as defaultTenantTransaction } from "./database";
import { createDistributionMethods } from "./distribution-service";
import { createInboxMethods } from "./inbox-service";
import { createPlatformMethods } from "./platform-service";

type Platform = components["schemas"]["Platform"];
type PlatformCapability = components["schemas"]["PlatformCapability"];

function capabilityMap(
  capabilities: readonly PlatformCapability[],
): ReadonlyMap<Platform, PlatformCapability> {
  return new Map(
    capabilities.map((capability) => [capability.platform, structuredClone(capability)]),
  );
}

export function createCoreApiService(
  configuredCapabilities = new ProviderRegistry().capabilities(),
  options: {
    now?: () => Date;
    tenantTransaction?: typeof defaultTenantTransaction;
  } = {},
): CoreApiService {
  const withTenantTransactionEffect = options.tenantTransaction ?? defaultTenantTransaction;
  const capabilities = capabilityMap(configuredCapabilities);
  const now = options.now ?? (() => new Date());

  return {
    ...createDistributionMethods(withTenantTransactionEffect),
    ...createPlatformMethods(capabilities, withTenantTransactionEffect),
    ...createAnalyticsMethods(capabilities, withTenantTransactionEffect, now),
    ...createInboxMethods(capabilities, withTenantTransactionEffect),
  };
}
