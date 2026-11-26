import { DatabaseError } from "@meltiply/domain";
import type { SessionClaims } from "@meltiply/auth";
import { Effect } from "effect";

import {
  channelRevocationEvent,
  mapBrandProfile,
  type CreateBrandProfileInput,
  type DisconnectableAccountRow,
  type UpdateBrandProfileInput,
} from "../brand-profile-rules";
import type { BrandProfileTransaction } from "./brand-profile-repository";
import {
  FakeTenantRepository,
  FakeTenantStore,
  FakeTenantTransaction,
  type FakeBrandProfileRow,
} from "./fake-tenant-repository";

export interface FakeDistribution {
  id: string;
  platform_account_id: string;
  status: string;
}

export interface FakeOutboxEvent {
  dedupeKey: string;
  org_id: string;
  payload: ReturnType<typeof channelRevocationEvent>["payload"];
}

export class FakeBrandProfileStore extends FakeTenantStore {
  readonly channels: (DisconnectableAccountRow & { org_id: string })[] = [];
  readonly distributions: FakeDistribution[] = [];
  readonly outbox: FakeOutboxEvent[] = [];

  constructor(
    readonly now: () => Date,
    readonly newId: () => string,
  ) {
    super();
  }
}

function normalizedName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function duplicateName(): DatabaseError {
  return new DatabaseError({ cause: { code: "23505" }, message: "Database query failed" });
}

class FakeBrandProfileTransaction extends FakeTenantTransaction implements BrandProfileTransaction {
  constructor(
    private readonly store: FakeBrandProfileStore,
    session: SessionClaims,
  ) {
    super(store, session);
  }

  private owned(profileId: string, organizationId: string): FakeBrandProfileRow | undefined {
    const profile = this.visibleBrandProfile(profileId);
    return profile?.org_id === organizationId ? profile : undefined;
  }

  private lockedRow(profileId: string, organizationId: string) {
    return this.lock(`brand-profile:${profileId}`).pipe(
      Effect.map(() => this.owned(profileId, organizationId)),
    );
  }

  private nameTaken(organizationId: string, name: string, exceptId?: string): boolean {
    return this.store.brandProfiles.some(
      (profile) =>
        profile.org_id === organizationId &&
        profile.id !== exceptId &&
        normalizedName(profile.name) === normalizedName(name),
    );
  }

  private listed(deleted: boolean) {
    return this.store.brandProfiles.filter(
      (profile) => this.canSee(profile) && (profile.deleted_at !== null) === deleted,
    );
  }

  activeBrandProfiles() {
    return Effect.sync(() =>
      this.listed(false)
        .toSorted((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
        .map((row) => mapBrandProfile({ ...row })),
    );
  }

  deletedBrandProfiles() {
    return Effect.sync(() =>
      this.listed(true)
        .toSorted((a, b) => compare(b.deleted_at!, a.deleted_at!) || compare(a.id, b.id))
        .map((row) => mapBrandProfile({ ...row })),
    );
  }

  brandProfile(profileId: string) {
    return Effect.sync(() => {
      const row = this.visibleBrandProfile(profileId);
      return row ? mapBrandProfile({ ...row }) : null;
    });
  }

  insertBrandProfile(organizationId: string, input: CreateBrandProfileInput) {
    return Effect.suspend(() => {
      if (this.nameTaken(organizationId, input.name)) return Effect.fail(duplicateName());
      const now = this.store.now().toISOString();
      const row: FakeBrandProfileRow = {
        color: input.color,
        created_at: now,
        deleted_at: null,
        description: input.description ?? null,
        id: this.store.newId(),
        name: input.name,
        org_id: organizationId,
        purge_at: null,
        updated_at: now,
      };
      this.insert(this.store.brandProfiles, row);
      return Effect.succeed(mapBrandProfile({ ...row }));
    });
  }

  updateBrandProfile(profileId: string, organizationId: string, input: UpdateBrandProfileInput) {
    return Effect.suspend(() => {
      const row = this.owned(profileId, organizationId);
      if (!row || row.deleted_at !== null || this.member?.role !== "admin") {
        return Effect.succeed(null);
      }
      if (input.name !== undefined && this.nameTaken(organizationId, input.name, profileId)) {
        return Effect.fail(duplicateName());
      }
      this.change(row, {
        color: input.color ?? row.color,
        description: input.description === undefined ? row.description : input.description,
        name: input.name ?? row.name,
        updated_at: this.store.now().toISOString(),
      });
      return Effect.succeed(mapBrandProfile({ ...row }));
    });
  }

  lockBrandProfileForDeletion(profileId: string, organizationId: string) {
    return this.lockedRow(profileId, organizationId).pipe(Effect.map((row) => row !== undefined));
  }

  lockBrandProfileRetention(profileId: string, organizationId: string) {
    return this.lockedRow(profileId, organizationId).pipe(
      Effect.map((row) => (row ? { deleted_at: row.deleted_at, purge_at: row.purge_at } : null)),
    );
  }

  brandProfileChannels(profileId: string, organizationId: string) {
    return Effect.sync(() =>
      this.store.channels
        .filter(
          (channel) => channel.brand_profile_id === profileId && channel.org_id === organizationId,
        )
        .map(({ access_token, brand_profile_id, id, platform }) => ({
          access_token,
          brand_profile_id,
          id,
          platform,
        })),
    );
  }

  disconnectChannel(organizationId: string, account: DisconnectableAccountRow) {
    return Effect.sync(() => {
      for (const distribution of this.store.distributions) {
        if (
          distribution.platform_account_id === account.id &&
          ["scheduled", "queued"].includes(distribution.status)
        ) {
          this.change(distribution, { status: "cancelled" });
        }
      }
      const channel = this.store.channels.find((candidate) => candidate.id === account.id);
      if (channel) this.remove(this.store.channels, channel);
      const event = channelRevocationEvent(account);
      const recorded = this.store.outbox.some(
        (existing) => existing.org_id === organizationId && existing.dedupeKey === event.dedupeKey,
      );
      if (!recorded) this.insert(this.store.outbox, { org_id: organizationId, ...event });
    });
  }

  deleteBrandProfile(profileId: string, organizationId: string) {
    return Effect.sync(() => {
      const row = this.owned(profileId, organizationId)!;
      this.remove(this.store.brandProfiles, row);
      return mapBrandProfile({ ...row });
    });
  }

  restoreBrandProfile(profileId: string, organizationId: string) {
    return Effect.sync(() => {
      const row = this.owned(profileId, organizationId)!;
      this.change(row, {
        deleted_at: null,
        purge_at: null,
        updated_at: this.store.now().toISOString(),
      });
      return mapBrandProfile({ ...row });
    });
  }
}

export class FakeBrandProfileRepository extends FakeTenantRepository<FakeBrandProfileTransaction> {
  constructor(readonly store: FakeBrandProfileStore) {
    super((session) => new FakeBrandProfileTransaction(store, session));
  }
}
