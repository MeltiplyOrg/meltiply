import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { INSTALLATION_SEAT_LIMIT } from "@meltiply/domain";

import { CoreApiError } from "./api-errors";

interface SeatUsage {
  activeMembers: number;
  pendingInvitations: number;
  used: number;
}

interface SeatUsageRow extends Record<string, unknown> {
  active_members: number | string;
  pending_invitations: number | string;
}

export function seatUsageEffect(
  client: EffectTransactionClient,
  orgId: string,
): Effect.Effect<SeatUsage, DatabaseError> {
  return client
    .query<SeatUsageRow>(
      `SELECT
         (SELECT count(*)
            FROM org_members om
            JOIN users u ON u.id = om.user_id
           WHERE om.org_id = $1 AND u.suspended_at IS NULL) AS active_members,
         (SELECT count(*)
            FROM workspace_invitations
           WHERE org_id = $1
             AND accepted_at IS NULL
             AND revoked_at IS NULL
             AND expires_at > now()) AS pending_invitations`,
      [orgId],
    )
    .pipe(
      Effect.map((result) => {
        const activeMembers = Number(result.rows[0]?.active_members ?? 0);
        const pendingInvitations = Number(result.rows[0]?.pending_invitations ?? 0);
        return {
          activeMembers,
          pendingInvitations,
          used: activeMembers + pendingInvitations,
        };
      }),
    );
}

export function requireSeatCapacityEffect(
  client: EffectTransactionClient,
  orgId: string,
  reservedSeats = 0,
): Effect.Effect<SeatUsage, CoreApiError | DatabaseError> {
  return seatUsageEffect(client, orgId).pipe(
    Effect.flatMap((usage) =>
      usage.used + reservedSeats <= INSTALLATION_SEAT_LIMIT
        ? Effect.succeed(usage)
        : Effect.fail(
            new CoreApiError(
              409,
              "seat_limit_reached",
              `This installation supports ${INSTALLATION_SEAT_LIMIT} people. Free a Seat first.`,
            ),
          ),
    ),
  );
}
