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

export type AutomationFlowRecorder = FlowLedgerRecorder;

const recorderCache = new WeakMap<AutomationEnv, AutomationFlowRecorder>();

export function flowRecorderFor(env: AutomationEnv): AutomationFlowRecorder {
  const cached = recorderCache.get(env);
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
  recorderCache.set(env, recorder);
  return recorder;
}
