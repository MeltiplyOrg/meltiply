export { makeJobContext } from "./job-context";
export {
  AmbiguousJobError,
  classifyJobError,
  RetryableJobError,
  TerminalJobError,
} from "./job-errors";
export type { AutomationJobError } from "./job-errors";
// Boundary: scope construction, exit→outcome mapping, outcome logging, and
// backoff math. All modules stay import-time pg-free (database access resolves
// dynamically inside factories), so unit tests import the barrel directly.
export { jobScope } from "./scope";
export type { JobScope } from "./scope";
export {
  configureJobLogging,
  exitToJobOutcome,
  logJobOutcome,
  queueBackoffDelaySeconds,
  recoverJobErrorCause,
  runJobProgram,
} from "./boundary";

export {
  createPublishQueueResolverLive,
  createPublishQueueResolverTest,
  createQueuePublisherLive,
  createQueuePublisherTest,
  PublishQueueResolver,
  QueuePublisher,
  ReplyWorkflowDispatcher,
} from "./services";
