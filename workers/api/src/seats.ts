import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { INSTALLATION_SEAT_LIMIT } from "@meltiply/domain";

import { CoreApiError } from "./core-types";

/** Installation-wide Seat usage for one Workspace. */
export interface SeatUsage {
  activeMembers: number;
  pendingInvitations: number;
  /** Active members plus pending invitations; the number compared with the limit. */
  used: number;
}

interface SeatUsageRow extends Record<string, unknown> {
  active_members: number | string;
  pending_invitations: number | string;
}

/**
 * Reads installation-wide Seat usage for a Workspace inside the caller's
 * transaction.
 *
 * Active membership excludes suspended accounts because suspension releases
 * the Seat. Pending, unexpired invitations reserve Seats; expired, revoked, and
 * accepted invitations do not. Callers that are about to consume a Seat must
 * first lock the `organizations` row (`lockOrganizationEffect`) so two
 * concurrent invitations cannot both observe capacity.
 *
 * @param client - Active transaction client.
 * @param orgId - Workspace UUID.
 * @returns Effect resolving active members, pending invitations, and their sum.
 */
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

/**
 * Fails unless one more Seat can be consumed at this instant.
 *
 * @param client - Active transaction client.
 * @param orgId - Workspace UUID.
 * @param reservedSeats - Seats being consumed by the current operation that are
 *   not yet visible in Seat usage (for example, a new invitation row).
 * @returns Effect resolving the current usage when capacity remains.
 * @throws {CoreApiError} 409 `seat_limit_reached` when the limit is exhausted.
 */
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
