import type { SessionClaims } from "@meltiply/auth";
import { ActiveOrganizationRequiredError, type DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import { inactiveBrandProfileError } from "../brand-profile-guard";
import type { CoreApiError } from "../core-types";
import { priorReservationError, type IdempotencyRecord } from "../idempotency";
import type { TenantRepository, TenantTransaction } from "./tenant-repository";

export interface FakeMember {
  organizationId: string;
  role: "admin" | "editor" | "viewer";
  subject: string;
}

export interface FakeBrandProfileRow {
  color: string;
  created_at: string;
  deleted_at: string | null;
  description: string | null;
  id: string;
  name: string;
  org_id: string;
  purge_at: string | null;
  updated_at: string;
}

export class FakeTenantStore {
  readonly brandProfiles: FakeBrandProfileRow[] = [];
  readonly idempotencyKeys = new Map<string, IdempotencyRecord>();
  readonly members: FakeMember[] = [];
  readonly locks = new Map<string, Promise<void>>();
  private commitFailure: DatabaseError | undefined;

  failNextCommit(error: DatabaseError): void {
    this.commitFailure = error;
  }

  takeCommitFailure(): DatabaseError | undefined {
    const failure = this.commitFailure;
    this.commitFailure = undefined;
    return failure;
  }
}

function knownTimezone(timezone: string): boolean {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions()
      .timeZone;
    return resolved === timezone || resolved.toLowerCase() !== timezone.toLowerCase();
  } catch {
    return false;
  }
}

export class FakeTenantTransaction implements TenantTransaction {
  private readonly held = new Map<string, () => void>();
  private readonly undo: (() => void)[] = [];

  commit(): Effect.Effect<void, DatabaseError> {
    return Effect.suspend(() => {
      const failure = this.tenant.takeCommitFailure();
      return failure ? Effect.fail(failure) : Effect.void;
    });
  }

  constructor(
    private readonly tenant: FakeTenantStore,
    private readonly session: SessionClaims,
  ) {}

  get member(): FakeMember | undefined {
    return this.tenant.members.find(
      (member) =>
        member.subject === this.session.subject &&
        member.organizationId === this.session.organizationId,
    );
  }

  visibleBrandProfile(id: string): FakeBrandProfileRow | undefined {
    return this.tenant.brandProfiles.find((profile) => profile.id === id && this.canSee(profile));
  }

  canSee(profile: FakeBrandProfileRow): boolean {
    const member = this.member;
    return (
      profile.org_id === member?.organizationId &&
      (profile.deleted_at === null || member.role === "admin")
    );
  }

  lock(key: string): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (this.held.has(key)) return;
      const previous = this.tenant.locks.get(key) ?? Promise.resolve();
      const released = new Promise<void>((resolve) => this.held.set(key, resolve));
      this.tenant.locks.set(
        key,
        previous.then(() => released),
      );
      await previous;
    });
  }

  insert<Row>(rows: Row[], row: Row): void {
    rows.push(row);
    this.undo.push(() => rows.splice(rows.indexOf(row), 1));
  }

  remove<Row>(rows: Row[], row: Row): void {
    const index = rows.indexOf(row);
    rows.splice(index, 1);
    this.undo.push(() => rows.splice(index, 0, row));
  }

  change<Row extends object>(row: Row, patch: Partial<Row>): void {
    const before = { ...row };
    Object.assign(row, patch);
    this.undo.push(() => Object.assign(row, before));
  }

  rollback(): void {
    for (const revert of this.undo.toReversed()) revert();
    this.undo.length = 0;
  }

  release(): void {
    for (const unlock of this.held.values()) unlock();
    this.held.clear();
  }

  activeOrganizationId(): Effect.Effect<string, ActiveOrganizationRequiredError> {
    return Effect.suspend(() => {
      const member = this.member;
      return member
        ? Effect.succeed(member.organizationId)
        : Effect.fail(
            new ActiveOrganizationRequiredError({
              message: "The authenticated identity is not an active organization member.",
            }),
          );
    });
  }

  activeRole(): Effect.Effect<string | null> {
    return Effect.sync(() => this.member?.role ?? null);
  }

  lockOrganization(organizationId: string): Effect.Effect<void> {
    return this.lock(`organization:${organizationId}`);
  }

  requireActiveBrandProfile(
    organizationId: string,
    brandProfileId: string,
  ): Effect.Effect<void, CoreApiError> {
    return Effect.suspend(() => {
      const profile = this.visibleBrandProfile(brandProfileId);
      const rejection = inactiveBrandProfileError(
        profile?.org_id === organizationId ? profile : undefined,
      );
      return rejection ? Effect.fail(rejection) : Effect.void;
    });
  }

  timezoneExists(timezone: string): Effect.Effect<boolean> {
    return Effect.sync(() => knownTimezone(timezone));
  }

  reserveIdempotency(
    organizationId: string,
    operation: string,
    idempotencyKey: string,
    requestHash: string,
  ): Effect.Effect<IdempotencyRecord | null, CoreApiError> {
    const key = JSON.stringify([organizationId, operation, idempotencyKey]);
    return Effect.flatMap(this.lock(`idempotency:${key}`), () => {
      const record = this.tenant.idempotencyKeys.get(key);
      if (!record) {
        this.tenant.idempotencyKeys.set(key, {
          request_hash: requestHash,
          response_body: null,
          response_status: null,
        });
        this.undo.push(() => this.tenant.idempotencyKeys.delete(key));
        return Effect.succeed(null);
      }
      const rejection = priorReservationError(record, requestHash);
      return rejection ? Effect.fail(rejection) : Effect.succeed({ ...record });
    });
  }

  completeIdempotency(
    organizationId: string,
    operation: string,
    idempotencyKey: string,
    status: number,
    body: unknown,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      const record = this.tenant.idempotencyKeys.get(
        JSON.stringify([organizationId, operation, idempotencyKey]),
      );
      if (record) {
        this.change(record, {
          response_body: JSON.parse(JSON.stringify(body ?? null)),
          response_status: status,
        });
      }
    });
  }
}

export class FakeTenantRepository<
  Transaction extends FakeTenantTransaction,
> implements TenantRepository<Transaction> {
  constructor(private readonly open: (session: SessionClaims) => Transaction) {}

  transaction<Value, Failure>(
    session: SessionClaims,
    work: (tx: Transaction) => Effect.Effect<Value, Failure>,
  ): Effect.Effect<Value, Failure | DatabaseError> {
    return Effect.suspend(() => {
      const tx = this.open(session);
      return work(tx).pipe(
        Effect.tap(() => tx.commit()),
        Effect.onError(() => Effect.sync(() => tx.rollback())),
        Effect.ensuring(Effect.sync(() => tx.release())),
      );
    });
  }
}
