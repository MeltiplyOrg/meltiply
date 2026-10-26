import type { DistributionStatus } from "@meltiply/domain";

/**
 * Status a publication-facing surface may display: every contract
 * `DistributionStatus`, the Post's own draft state, and the neutral fallback
 * for malformed, absent, or newly introduced values.
 */
export type PublicationStatus = DistributionStatus | "draft" | "unknown";

/** Toolbar buckets derived from a Channel outcome; `null` matches no bucket. */
export type PublicationStatusFilter = "draft" | "scheduled" | "published" | "failed" | null;

/** Behavior and ordering every publication status resolves through. */
interface PublicationStatusDefinition {
  /** Lifecycle rank used by status-grouped views. */
  group: number;
  /** Aggregation rank when one Post's Channels disagree; lower wins. */
  summary: number;
  /** Toolbar bucket the outcome contributes to. */
  filter: PublicationStatusFilter;
  /** The contract still accepts cancel/reschedule mutations. */
  cancellable: boolean;
  /** A Provider attempt may have published, so deletion is Admin-only. */
  deleteProtected: boolean;
  /** Polling must continue while the outcome is unresolved. */
  inFlight: boolean;
}

/**
 * The single source of truth for publication status behavior. Group order runs
 * through the lifecycle; summary order puts actionable and ambiguous outcomes
 * first so a multi-Channel Post never reads as a clean success while one Channel
 * still needs attention. Unknown ranks last and is only surfaced when nothing
 * recognized is present.
 */
const PUBLICATION_STATUSES = {
  draft: {
    group: 0,
    summary: 9,
    filter: "draft",
    cancellable: false,
    deleteProtected: false,
    inFlight: false,
  },
  scheduled: {
    group: 1,
    summary: 5,
    filter: "scheduled",
    cancellable: true,
    deleteProtected: false,
    inFlight: false,
  },
  queued: {
    group: 2,
    summary: 4,
    filter: "scheduled",
    cancellable: true,
    deleteProtected: false,
    inFlight: true,
  },
  processing: {
    group: 3,
    summary: 2,
    filter: "scheduled",
    cancellable: true,
    deleteProtected: true,
    inFlight: true,
  },
  awaiting_provider: {
    group: 4,
    summary: 3,
    filter: "scheduled",
    cancellable: true,
    deleteProtected: true,
    inFlight: true,
  },
  published: {
    group: 5,
    summary: 8,
    filter: "published",
    cancellable: false,
    deleteProtected: true,
    inFlight: false,
  },
  failed: {
    group: 6,
    summary: 0,
    filter: "failed",
    cancellable: false,
    deleteProtected: false,
    inFlight: false,
  },
  needs_reconciliation: {
    group: 7,
    summary: 1,
    filter: "failed",
    cancellable: true,
    deleteProtected: true,
    inFlight: false,
  },
  cancel_requested: {
    group: 8,
    summary: 6,
    filter: "scheduled",
    cancellable: false,
    deleteProtected: false,
    inFlight: true,
  },
  cancelled: {
    group: 9,
    summary: 7,
    filter: null,
    cancellable: false,
    deleteProtected: false,
    inFlight: false,
  },
  unknown: {
    group: 10,
    summary: 10,
    filter: null,
    cancellable: false,
    deleteProtected: false,
    inFlight: false,
  },
} as const satisfies Record<PublicationStatus, PublicationStatusDefinition>;

/**
 * Resolves any raw publication value to its canonical status. Case and
 * surrounding whitespace are ignored; absent, blank, and unrecognized values
 * all become `unknown` so they can never render as healthy scheduling.
 *
 * @param value - Raw Channel or Post status from the contract or a view model.
 * @returns A contract status, `draft`, or the neutral `unknown` fallback.
 */
export function resolvePublicationStatus(value: string | null | undefined): PublicationStatus {
  const status = value?.trim().toLowerCase();
  return status && Object.hasOwn(PUBLICATION_STATUSES, status)
    ? (status as PublicationStatus)
    : "unknown";
}

/** Reports whether a contract `DistributionStatus` still accepts cancel/reschedule. */
export function isCancellablePublicationStatus(status: string): boolean {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].cancellable;
}

/** Reports whether a Provider attempt may have published, making deletion Admin-only. */
export function isDeleteProtectedPublicationStatus(status: string): boolean {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].deleteProtected;
}

/** Reports whether an unresolved outcome must keep polling. */
export function isInFlightPublicationStatus(status: string): boolean {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].inFlight;
}

/**
 * Maps a Channel outcome onto the Posts toolbar bucket it contributes to.
 * Unknown and terminal cancellation statuses belong to no bucket.
 */
export function publicationStatusFilterBucket(status: string): PublicationStatusFilter {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].filter;
}

/**
 * Compares two statuses by lifecycle rank for status-grouped views. Unknown
 * values sort last rather than creating a provider-specific group.
 */
export function comparePublicationStatusGroup(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return (
    PUBLICATION_STATUSES[resolvePublicationStatus(a)].group -
    PUBLICATION_STATUSES[resolvePublicationStatus(b)].group
  );
}

/**
 * Aggregates independent Channel outcomes into the single status a row shows.
 *
 * Actionable states outrank in-flight work, which outranks pending schedules,
 * which outranks terminal publication/cancellation. Unrecognized values never
 * outrank a recognized outcome; if every supplied value is unknown, the
 * aggregate is `unknown` rather than the fallback. The fallback is used only
 * when the Post has no Channel outcome at all.
 *
 * @param statuses - Raw status strings from the row's Channel outcomes.
 * @param fallback - Status used when no outcome exists yet; defaults to `draft`.
 * @returns The highest-priority canonical status.
 */
export function summarizePublicationStatuses(
  statuses: readonly (string | null | undefined)[],
  fallback = "draft",
): PublicationStatus {
  let best: PublicationStatus | null = null;
  for (const raw of statuses) {
    const status = resolvePublicationStatus(raw);
    if (status === "unknown") continue;
    if (
      best === null ||
      PUBLICATION_STATUSES[status].summary < PUBLICATION_STATUSES[best].summary
    ) {
      best = status;
    }
  }
  if (best !== null) return best;
  return statuses.length > 0 ? "unknown" : resolvePublicationStatus(fallback);
}
