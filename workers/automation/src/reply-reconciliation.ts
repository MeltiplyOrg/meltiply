import { Effect } from "effect";

import { claimDueOutboxWork } from "./due-work";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";

export function enqueueDueReplyReconciliations(
  env: AutomationEnv,
  limit = 50,
): Effect.Effect<number, AutomationJobError> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return Effect.fail(
      classifyJobError(new RangeError("reply reconciliation limit must be between 1 and 100")),
    );
  }

  return claimDueOutboxWork(env, "reply_reconciliation", limit);
}
