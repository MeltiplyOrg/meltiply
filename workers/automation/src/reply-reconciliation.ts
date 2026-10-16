import { Effect } from "effect";

import { claimDueOutboxWork } from "./due-work";
import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";

/**
 * Enqueue durable reply lookups whose worker lease is no longer active.
 *
 * Reconciliation messages carry only the comment identifier and a marker. The
 * reply processor uses that identifier to load the durable provider operation;
 * when the operation is started or ambiguous it performs a provider lookup,
 * rather than blindly reposting text that may already have been delivered.
 * An out-of-range limit still means caller misuse, but it now surfaces inside
 * the Effect as a classified failure: classifyJobError wraps the RangeError
 * into a RetryableJobError whose `cause` preserves "RangeError".
 *
 * @param env - Automation worker environment.
 * @param limit - Maximum number of candidate comments to claim (default 50, bound 1-100).
 * @returns Effect producing the number of reply reconciliation outbox events claimed and emitted; fails with a classified AutomationJobError (a RangeError for invalid limits becomes RetryableJobError).
 */
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
