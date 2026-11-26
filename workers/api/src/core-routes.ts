import { DatabaseError } from "@meltiply/domain";
import { createProviderRegistryFromEnvironment, type ProviderRegistry } from "@meltiply/providers";
import type { StorageService } from "@meltiply/storage";
import { Effect, type Layer } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "./api-errors";
import type { AssetApiService } from "./asset-types";
import type { BrandProfileApiService } from "./brand-profile-service";
import type { CoreApiService } from "./core-types";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
import type { PostApiService } from "./post-types";
import type { PublishingPreferencesApiService } from "./publishing-preferences-service";
import { registerPublishingQueueRoutes } from "./publishing-queue-routes";
import type { PublishingQueueApiService } from "./publishing-queue-service";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerAssetRoutes } from "./routes/assets";
import { registerBrandProfileRoutes } from "./routes/brand-profiles";
import { registerDistributionRoutes } from "./routes/distributions";
import { registerInboxAndPreferencesRoutes } from "./routes/inbox-and-preferences";
import { oauthStateRoutingKey, registerPlatformRoutes } from "./routes/platforms";
import { registerPostRoutes } from "./routes/posts";
import type {
  CoreRouteServices,
  OAuthConnectionRevoker,
  OAuthConnectionSaver,
  PublicationRequirementsReader,
} from "./routes/shared";
import {
  registerWorkspaceLifecycleRoutes,
  type WorkspaceLifecycleDependencies,
} from "./workspace-lifecycle";

export { oauthStateRoutingKey };

export interface CoreRouteDependencies {
  assetService?: AssetApiService;
  brandProfileService?: BrandProfileApiService;
  coreService?: CoreApiService;
  postService?: PostApiService;
  publishingPreferencesService?: PublishingPreferencesApiService;
  publishingQueueService?: PublishingQueueApiService;
  providerRegistry?: ProviderRegistry;
  publicationRequirements?: PublicationRequirementsReader;
  revokeOAuthConnection?: OAuthConnectionRevoker;
  saveOAuthConnection?: OAuthConnectionSaver;
  storageServiceLayer?:
    | Layer.Layer<StorageService, never, never>
    | ((env: ApiWorkerEnv) => Layer.Layer<StorageService, never, never>);
  workspaceLifecycle?: WorkspaceLifecycleDependencies;
}

export function registerCoreRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: CoreRouteDependencies = {},
): void {
  let providerRegistry = dependencies.providerRegistry;
  const registry = (): ProviderRegistry => {
    if (!providerRegistry) {
      throw new Error("provider registry was not initialized");
    }
    return providerRegistry;
  };
  app.use("/api/v1/*", async (c, next) => {
    providerRegistry ??= createProviderRegistryFromEnvironment(c.env);
    await next();
  });

  let servicePromise: Promise<CoreApiService> | undefined;
  let assetServicePromise: Promise<AssetApiService> | undefined;
  let brandProfileServicePromise: Promise<BrandProfileApiService> | undefined;
  let postServicePromise: Promise<PostApiService> | undefined;
  let preferencesServicePromise: Promise<PublishingPreferencesApiService> | undefined;

  const services: CoreRouteServices = {
    assets: async () => {
      if (dependencies.assetService) return dependencies.assetService;
      assetServicePromise ??= import("./asset-service").then((module) =>
        module.createAssetApiService(),
      );
      return assetServicePromise;
    },
    brandProfiles: async () => {
      if (dependencies.brandProfileService) return dependencies.brandProfileService;
      brandProfileServicePromise ??= import("./brand-profile-service").then((module) =>
        module.createBrandProfileService(),
      );
      return brandProfileServicePromise;
    },
    posts: async () => {
      if (dependencies.postService) return dependencies.postService;
      postServicePromise ??= import("./post-service").then((module) =>
        module.createPostApiService(registry().capabilities()),
      );
      return postServicePromise;
    },
    preferences: async () => {
      if (dependencies.publishingPreferencesService) {
        return dependencies.publishingPreferencesService;
      }
      preferencesServicePromise ??= import("./publishing-preferences-service").then((module) =>
        module.createPublishingPreferencesApiService(),
      );
      return preferencesServicePromise;
    },
    readPublicationRequirements:
      dependencies.publicationRequirements ??
      ((env, session, accountId, providerRequestId, activeRegistry) =>
        Effect.tryPromise({
          catch: (cause) =>
            cause instanceof CoreApiError
              ? cause
              : new DatabaseError({
                  cause,
                  message: "The publication requirements could not be retrieved.",
                }),
          try: () => import("./publication-requirements"),
        }).pipe(
          Effect.flatMap((module) =>
            module.getPublicationRequirementsEffect(
              env,
              session,
              accountId,
              providerRequestId,
              activeRegistry,
            ),
          ),
        )),
    registry,
    resolveStorageLayer: (env) => {
      if (!dependencies.storageServiceLayer) return undefined;
      return typeof dependencies.storageServiceLayer === "function"
        ? dependencies.storageServiceLayer(env)
        : dependencies.storageServiceLayer;
    },
    revokeConnection:
      dependencies.revokeOAuthConnection ??
      ((env, session, accountId, activeRegistry) =>
        Effect.tryPromise(() => import("./oauth-revoke")).pipe(
          Effect.flatMap((module) =>
            module.revokeOAuthConnectionEffect(env, session, accountId, activeRegistry),
          ),
        )),
    saveConnection:
      dependencies.saveOAuthConnection ??
      ((env, selected, owner, connection) =>
        Effect.tryPromise({
          catch: (cause) =>
            cause instanceof CoreApiError
              ? cause
              : new DatabaseError({
                  cause,
                  message: "The OAuth connection could not be stored.",
                }),
          try: () => import("./oauth-connection"),
        }).pipe(
          Effect.flatMap((module) =>
            module.saveOAuthConnectionEffect(env, selected, owner, connection),
          ),
        )),
    service: async () => {
      if (dependencies.coreService) return dependencies.coreService;
      servicePromise ??= import("./core-service").then((module) =>
        module.createCoreApiService(registry().capabilities()),
      );
      return servicePromise;
    },
  };

  registerBrandProfileRoutes(app, services);
  registerAssetRoutes(app, services);
  registerPlatformRoutes(app, services);
  registerPostRoutes(app, services);
  registerDistributionRoutes(app, services);
  registerAnalyticsRoutes(app, services);
  registerInboxAndPreferencesRoutes(app, services);
  registerWorkspaceLifecycleRoutes(app, dependencies.workspaceLifecycle);
  registerPublishingQueueRoutes(app, dependencies.publishingQueueService);
}
