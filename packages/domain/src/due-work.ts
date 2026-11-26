/** Longest per-message delay the Queue platform accepts; later work waits for the Due work claim. */
export const maximumDelayedDeliverySeconds = 86_400;

/** Grace before overdue scheduled work whose trigger was lost is re-emitted by recovery. */
export const overdueRecoveryGraceSeconds = 300;

/** Published-Distribution age after which analytics sync stops: the widest range `GET /api/v1/analytics` serves. */
export const analyticsTerminalAgeSeconds = 366 * 86_400;

/** Published-Distribution age after which Comment sync runs only when the Inbox requests it. */
export const demandDrivenCommentsAgeSeconds = 30 * 86_400;
