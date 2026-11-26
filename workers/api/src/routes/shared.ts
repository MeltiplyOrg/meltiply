import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError, Platform } from "@meltiply/domain";
import type {
  OAuthConnection,
  ProviderPublicationRequirements,
  ProviderRegistry,
  ProviderService,
} from "@meltiply/providers";
import type { StorageService } from "@meltiply/storage";
import { Effect, type Layer } from "effect";
import type { Context } from "hono";

import type { CoreApiError } from "../api-errors";
import type { AssetApiService } from "../asset-types";
import type { BrandProfileApiService } from "../brand-profile-service";
import type { CoreApiService } from "../core-types";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../env";
import type { OAuthConnectionOwner } from "../oauth-connection";
import type { PostApiService } from "../post-types";
import type { PublishingPreferencesApiService } from "../publishing-preferences-service";
import { uuidParam } from "../validation";

export type OAuthConnectionRevoker = (
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  registry: ProviderRegistry,
) => Effect.Effect<void, unknown, ProviderService>;

export type OAuthConnectionSaver = (
  env: ApiWorkerEnv,
  platform: Platform,
  owner: OAuthConnectionOwner,
  connection: OAuthConnection,
) => Effect.Effect<void, CoreApiError | DatabaseError>;

export type PublicationRequirementsReader = (
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  requestId: string,
  registry: ProviderRegistry,
) => Effect.Effect<ProviderPublicationRequirements, CoreApiError | DatabaseError, ProviderService>;

export interface CoreRouteServices {
  assets: () => Promise<AssetApiService>;
  brandProfiles: () => Promise<BrandProfileApiService>;
  posts: () => Promise<PostApiService>;
  preferences: () => Promise<PublishingPreferencesApiService>;
  readPublicationRequirements: PublicationRequirementsReader;
  registry: () => ProviderRegistry;
  resolveStorageLayer: (
    env: ApiWorkerEnv,
  ) => Layer.Layer<StorageService, unknown, never> | undefined;
  revokeConnection: OAuthConnectionRevoker;
  saveConnection: OAuthConnectionSaver;
  service: () => Promise<CoreApiService>;
}

export function optionalBrandProfileParam(c: Context<ApiWorkerEnvironment>): string | undefined {
  const value = c.req.query("brand_profile_id");
  return value ? uuidParam(value, "brand_profile_id") : undefined;
}

export function withStorageLayer<A, E, R>(
  program: Effect.Effect<A, E, R>,
  layer: Layer.Layer<StorageService, unknown, never> | undefined,
): Effect.Effect<A, E, R> {
  return layer ? (program.pipe(Effect.provide(layer)) as Effect.Effect<A, E, R>) : program;
}
