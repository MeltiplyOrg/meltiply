export interface JobContextData {
  readonly jobId: string;
  readonly organizationId?: string;
  readonly queue?: string;
  readonly requestId?: string;
  readonly source: "queue" | "scheduled" | "workflow" | "direct";
  readonly traceId: string;
  readonly workflowId?: string;
}

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
