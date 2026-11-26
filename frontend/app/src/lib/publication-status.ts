import type { DistributionStatus } from "@meltiply/domain";

export type PublicationStatus = DistributionStatus | "draft" | "unknown";

export type PublicationStatusFilter = "draft" | "scheduled" | "published" | "failed" | null;

interface PublicationStatusDefinition {
  group: number;
  summary: number;
  filter: PublicationStatusFilter;
  cancellable: boolean;
  deleteProtected: boolean;
  inFlight: boolean;
}

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
  delivered: {
    group: 5,
    summary: 3,
    filter: null,
    cancellable: false,
    deleteProtected: true,
    inFlight: false,
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

export function resolvePublicationStatus(value: string | null | undefined): PublicationStatus {
  const status = value?.trim().toLowerCase();
  return status && Object.hasOwn(PUBLICATION_STATUSES, status)
    ? (status as PublicationStatus)
    : "unknown";
}

export function isCancellablePublicationStatus(status: string): boolean {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].cancellable;
}

export function isDeleteProtectedPublicationStatus(status: string): boolean {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].deleteProtected;
}

export function isInFlightPublicationStatus(status: string): boolean {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].inFlight;
}

export function publicationStatusFilterBucket(status: string): PublicationStatusFilter {
  return PUBLICATION_STATUSES[resolvePublicationStatus(status)].filter;
}

export function comparePublicationStatusGroup(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return (
    PUBLICATION_STATUSES[resolvePublicationStatus(a)].group -
    PUBLICATION_STATUSES[resolvePublicationStatus(b)].group
  );
}

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
