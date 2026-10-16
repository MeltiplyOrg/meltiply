/**
 * Longest per-message delivery delay the Queue platform accepts — 24 hours.
 * A Schedule recorded further out than this horizon sends no delayed command;
 * it stays discoverable by the Due work claim once it comes due.
 */
export const maximumDelayedDeliverySeconds = 86_400;

/**
 * Operational grace period (5 minutes) before overdue scheduled work whose
 * trigger was lost is re-emitted by the recovery sweep.
 */
export const overdueRecoveryGraceSeconds = 300;

/**
 * Age at which a published Distribution stops being scheduled for analytics
 * synchronization — 366 days, the widest range `GET /api/v1/analytics` will
 * serve (`workers/api/src/core-routes.ts`). No analytics read can place a
 * Distribution older than this inside its window, so a further provider call
 * buys nothing; the schedule terminates and `analytics_next_sync_at` stays
 * absent. Snapshots already collected remain readable.
 */
export const analyticsTerminalAgeSeconds = 366 * 86_400;

/**
 * Age (30 days) past which a published Distribution's Comment sync stops being
 * scheduled and becomes demand-driven: the Inbox arms one bounded fetch when a
 * creator looks at those Distributions. It is the end of the cadence ladder's
 * last distinct rung, so no live rung changes; past it the ladder's daily floor
 * would poll every Distribution forever for Comments nobody is reading.
 *
 * Comments are not simply abandoned like analytics, because an unanswered
 * Comment is a live customer interaction rather than an archival metric.
 */
export const demandDrivenCommentsAgeSeconds = 30 * 86_400;
