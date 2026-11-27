import { Cause, Exit } from "effect";
import {
  createFlowLedgerRecorder,
  flowDatabaseAvailable,
  flowExplorerEnabled,
  type FlowLedgerRecorder,
} from "@meltiply/observability";

import { runJobProgram } from "./effect/boundary";
import type { AutomationEnv } from "./env";

export { flowDatabaseAvailable, flowExplorerEnabled };

const recorderCache = new WeakMap<object, FlowLedgerRecorder>();

export function flowRecorderFor(env: AutomationEnv): FlowLedgerRecorder {
  const cacheKey: object = env.DB_SYSTEM ?? env;
  const cached = recorderCache.get(cacheKey);
  if (cached) return cached;
  const recorder = createFlowLedgerRecorder({
    env,
    runTransaction: async (operation) => {
      const { withSystemTransactionEffect } = await import("./database");
      const exit = await runJobProgram(withSystemTransactionEffect(env, operation));
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.squash(exit.cause);
    },
    service: "automation",
  });
  recorderCache.set(cacheKey, recorder);
  return recorder;
}
