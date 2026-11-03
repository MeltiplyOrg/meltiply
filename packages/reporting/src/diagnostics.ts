import type { Platform } from "@meltiply/domain";

import type {
  DiagnosticCategory,
  DiagnosticReportInput,
  OperationCategory,
  ProviderFailureClass,
} from "./contracts";

/**
 * Boundary adaptation for Worker failure surfaces.
 *
 * Every production failure boundary — an HTTP route's defect path, an
 * asynchronous queue or scheduled unit, a workflow step — already has a
 * `DiagnosticReportInput`-shaped decision to make: which fixed category, which
 * operation grouping, whether the failure was expected, and which canonical
 * Provider class applies. This module owns that translation so a boundary can
 * never hand the reporting module a raw error object, a runtime message, a
 * request or a serialized domain record.
 *
 * The runtime message is deliberately absent: only a class name and a bounded
 * stack travel, and the reporting module keeps solely the allowlisted
 * application frames from that stack. A defect whose text names a Post title, an
 * email, a signed media URL or a Provider response body therefore cannot reach a
 * payload, an exception group name or a dashboard.
 */

/** Raw stack text retained before the module's frame allowlist runs. */
const maximumStackCharacters = 8_192;

/** Fixed report shape a boundary supplies; everything else is derived. */
export interface DiagnosticBoundaryInput {
  /** Fixed failure class; defaults to `unhandled_exception`. */
  readonly category?: DiagnosticCategory;
  /**
   * Canonical Provider class, required for `provider_failure`.
   *
   * Callers extract it from the adapter failure they already classified; this
   * module never reads a Provider message or status text.
   */
  readonly failureClass?: ProviderFailureClass;
  /** Whether the failure was already handled by the boundary. */
  readonly handled?: boolean;
  /** Frozen logical identity, when a boundary can build one itself. */
  readonly logicalId?: string;
  /** Operation grouping the maintainer uses to prioritize repairs. */
  readonly operation: OperationCategory;
  /** Instant the failure occurred; defaults to the boundary's clock. */
  readonly occurredAt?: string;
  /** Platform the failing work belonged to, when one applies. */
  readonly platform?: Platform;
}

/**
 * Reduces an arbitrary thrown value to a class name and a bounded stack.
 *
 * A non-`Error` throw (a rejected string, an Effect defect wrapper payload)
 * yields the neutral `Error` name rather than its text, so a message-shaped
 * value cannot become the exception type.
 *
 * @param cause - Thrown or squashed value at the boundary.
 * @returns Plain name plus a truncated stack when the value is an `Error`.
 */
function errorShape(cause: unknown): { name: string; stack?: string } {
  if (!(cause instanceof Error)) return { name: "Error" };
  const stack = typeof cause.stack === "string" ? cause.stack : undefined;
  return {
    name: typeof cause.name === "string" && cause.name.length > 0 ? cause.name : "Error",
    ...(stack ? { stack: stack.slice(0, maximumStackCharacters) } : {}),
  };
}

/**
 * Builds the approved diagnostic report for one boundary failure.
 *
 * @param cause - Thrown value or squashed Effect cause at the boundary.
 * @param input - Fixed category, operation, platform and logical identity.
 * @returns Report ready for `ReportingService.enqueueDiagnostic`.
 */
export function diagnosticReportInput(
  cause: unknown,
  input: DiagnosticBoundaryInput,
): DiagnosticReportInput {
  const category = input.category ?? "unhandled_exception";
  return {
    category,
    ...(category === "provider_failure" && input.failureClass !== undefined
      ? { failureClass: input.failureClass }
      : {}),
    ...(input.logicalId === undefined ? {} : { logicalId: input.logicalId }),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    operation: input.operation,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    // An expected Provider condition is handled by the caller by definition: the
    // adapter classified it and the retry/reconciliation path owns the outcome.
    // Unexpected categories default to unhandled unless the boundary knows it
    // converted the failure into a client-visible recovery.
    handled: input.handled ?? category === "provider_failure",
    error: errorShape(cause),
  };
}
