/**
 * Shared improvement-reporting module.
 *
 * One place owns the event catalog, minimization and sanitization, consent and
 * policy evaluation, logical delivery identity, bounded durable delivery and the
 * PostHog capture adapter. Workers compose a `ReportingService` layer; they never
 * construct a capture client, restate a privacy rule or run a reporting timer of
 * their own.
 *
 * Canonical operational observability (`@meltiply/observability`) stays separate:
 * local logs, traces and the browser diagnostic producer remain installation-local
 * and are never an implicit PostHog feed.
 */
export * from "./configuration";
export * from "./contracts";
export * from "./policy";
export * from "./sanitize";
export * from "./service";
export * from "./transport";
