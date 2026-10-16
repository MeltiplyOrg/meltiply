/**
 * Immutable job-scoped execution metadata for one automation unit of work.
 * Carries correlation identifiers plus the Cloudflare entry source so queue,
 * scheduled, and workflow executions stay distinguishable in logs and traces.
 */
export interface JobContextData {
  readonly jobId: string;
  readonly organizationId?: string;
  readonly queue?: string;
  readonly requestId?: string;
  readonly source: "queue" | "scheduled" | "workflow" | "direct";
  readonly traceId: string;
  readonly workflowId?: string;
}

/**
 * Creates a validated JobContextData record for dependency injection.
 *
 * Requires job and trace identifiers; every other field is optional
 * correlation carried through logs, flow-ledger rows, and provider request
 * contexts.
 *
 * @param data - Job correlation including source discriminator and identifiers.
 * @returns Fully populated, immutable JobContextData instance.
 */
export function makeJobContext(data: {
  readonly jobId: string;
  readonly organizationId?: string;
  readonly queue?: string;
  readonly requestId?: string;
  readonly source: JobContextData["source"];
  readonly traceId: string;
  readonly workflowId?: string;
}): JobContextData {
  return {
    jobId: data.jobId,
    ...(data.organizationId ? { organizationId: data.organizationId } : {}),
    ...(data.queue ? { queue: data.queue } : {}),
    ...(data.requestId ? { requestId: data.requestId } : {}),
    source: data.source,
    traceId: data.traceId,
    ...(data.workflowId ? { workflowId: data.workflowId } : {}),
  };
}
