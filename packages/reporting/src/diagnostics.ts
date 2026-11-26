import type { Platform } from "@meltiply/domain";

import {
  isProviderFailureClass,
  type DiagnosticCategory,
  type DiagnosticReportInput,
  type OperationCategory,
  type ProviderFailureClass,
} from "./contracts";

const maximumStackCharacters = 8_192;

export interface DiagnosticBoundaryInput {
  readonly category?: DiagnosticCategory;
  readonly failureClass?: ProviderFailureClass;
  readonly handled?: boolean;
  readonly logicalId?: string;
  readonly operation: OperationCategory;
  readonly occurredAt?: string;
  readonly platform?: Platform;
}

function errorShape(cause: unknown): { name: string; stack?: string } {
  if (!(cause instanceof Error)) return { name: "Error" };
  const stack = typeof cause.stack === "string" ? cause.stack : undefined;
  return {
    name: typeof cause.name === "string" && cause.name.length > 0 ? cause.name : "Error",
    ...(stack ? { stack: stack.slice(0, maximumStackCharacters) } : {}),
  };
}

export function extractProviderFailureClass(cause: unknown): ProviderFailureClass | undefined {
  if (cause === null || typeof cause !== "object" || !("failure" in cause)) return undefined;
  const failure = (cause as { failure?: unknown }).failure;
  if (failure === null || typeof failure !== "object" || !("classification" in failure)) {
    return undefined;
  }
  const classification = (failure as { classification?: unknown }).classification;
  return isProviderFailureClass(classification) ? classification : undefined;
}

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
    handled: input.handled ?? category === "provider_failure",
    error: errorShape(cause),
  };
}
