import { Effect } from "effect";
import { isUuid } from "@meltiply/domain";
import { withSystemTransactionEffect } from "./database";
import type { AutomationEnv } from "./env";
import { isOutboxMessage } from "./messages";

export function partitionPublishBatch(env: AutomationEnv, messages: readonly Message<unknown>[]) {
  const ids = [
    ...new Set(
      messages.flatMap((message) => {
        const body = message.body;
        return isOutboxMessage(body) && isUuid(body.aggregate_id) ? [body.aggregate_id] : [];
      }),
    ),
  ];
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      const result =
        ids.length === 0
          ? { rows: [] }
          : yield* client.query<{
              id: string;
              platform: string;
              platform_user_id: string | null;
            }>(
              `SELECT distribution.id, distribution.platform, account.platform_user_id
        FROM distributions distribution
        LEFT JOIN platform_accounts account ON account.id = distribution.platform_account_id
        WHERE distribution.id = ANY($1::uuid[])`,
              [ids],
            );
      const accounts = new Map(
        result.rows.map((row) => [
          row.id,
          row.platform_user_id === null ? "unknown" : `${row.platform}:${row.platform_user_id}`,
        ]),
      );
      const groups = new Map<string, Message<unknown>[]>();
      for (const message of messages) {
        const key = isOutboxMessage(message.body)
          ? (accounts.get(message.body.aggregate_id) ?? "unknown")
          : "unknown";
        const group = groups.get(key);
        if (group) group.push(message);
        else groups.set(key, [message]);
      }
      return [...groups.values()];
    }),
  );
}

export async function consumePublishPartitions(
  partitions: readonly (readonly Message<unknown>[])[],
  consume: (message: Message<unknown>) => Promise<void>,
) {
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(2, partitions.length) }, async () => {
      for (;;) {
        const partition = partitions[next++];
        if (!partition) return;
        for (const message of partition) {
          try {
            await consume(message);
          } catch (cause) {
            failures.push(cause);
            break;
          }
        }
      }
    }),
  );
  if (failures.length > 0)
    throw new AggregateError(failures, "Publish batch contains unsettled message failures");
}
