import type { DatabaseError } from "@meltiply/domain";
import type { Effect } from "effect";

import type {
  BrandProfile,
  BrandProfileRetention,
  CreateBrandProfileInput,
  DisconnectableAccountRow,
  UpdateBrandProfileInput,
} from "../brand-profile-rules";
import type { TenantRepositoryProvider, TenantTransaction } from "./tenant-repository";

export interface BrandProfileQueries {
  activeBrandProfiles(): Effect.Effect<BrandProfile[], DatabaseError>;
  deletedBrandProfiles(): Effect.Effect<BrandProfile[], DatabaseError>;
  brandProfile(profileId: string): Effect.Effect<BrandProfile | null, DatabaseError>;
  insertBrandProfile(
    organizationId: string,
    input: CreateBrandProfileInput,
  ): Effect.Effect<BrandProfile, DatabaseError>;
  updateBrandProfile(
    profileId: string,
    organizationId: string,
    input: UpdateBrandProfileInput,
  ): Effect.Effect<BrandProfile | null, DatabaseError>;
  lockBrandProfileForDeletion(
    profileId: string,
    organizationId: string,
  ): Effect.Effect<boolean, DatabaseError>;
  lockBrandProfileRetention(
    profileId: string,
    organizationId: string,
  ): Effect.Effect<BrandProfileRetention | null, DatabaseError>;
  brandProfileChannels(
    profileId: string,
    organizationId: string,
  ): Effect.Effect<DisconnectableAccountRow[], DatabaseError>;
  disconnectChannel(
    organizationId: string,
    account: DisconnectableAccountRow,
  ): Effect.Effect<void, DatabaseError>;
  deleteBrandProfile(
    profileId: string,
    organizationId: string,
  ): Effect.Effect<BrandProfile, DatabaseError>;
  restoreBrandProfile(
    profileId: string,
    organizationId: string,
  ): Effect.Effect<BrandProfile, DatabaseError>;
}

export type BrandProfileTransaction = TenantTransaction & BrandProfileQueries;

export type BrandProfileRepositoryProvider = TenantRepositoryProvider<BrandProfileTransaction>;
