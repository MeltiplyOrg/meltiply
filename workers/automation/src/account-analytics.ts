import { Effect } from "effect";
import { PLATFORM_IDS } from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";
import {
  cachedProviderRegistryFromEnvironment,
  createProviderServiceLive,
  type ProviderAccountAnalytics,
  type ProviderRegistry,
  type ProviderRequestContext,
} from "@meltiply/providers";

import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import { decryptStoredToken } from "./provider-credentials";
import { executeProviderAccountAnalyticsEffect } from "./provider-sync-provider";
import {
  createPostgresAccountAnalyticsRepository,
  type AccountAnalyticsRepository,
} from "./repositories/account-analytics-repository";

export interface AccountAnalyticsSweepResult {
  failed: number;
  recorded: number;
  scanned: number;
}

const sweepBatchSize = 25;
const sweepIntervalHours = 6;

export function sweepAccountAnalytics(
  env: AutomationEnv,
  dependencies: {
    providerRegistry?: ProviderRegistry;
    repository?: AccountAnalyticsRepository;
  } = {},
): Effect.Effect<AccountAnalyticsSweepResult, AutomationJobError> {
  return Effect.gen(function* () {
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const repository = dependencies.repository ?? createPostgresAccountAnalyticsRepository(env);
    const decryptToken = decryptStoredToken(env);
    const platforms = PLATFORM_IDS.filter(
      (platform) => registry.get(platform)?.getAccountAnalytics,
    );
    if (platforms.length === 0) return { failed: 0, recorded: 0, scanned: 0 };
    const rows = yield* repository.claimCandidates(sweepIntervalHours, sweepBatchSize, platforms);

    const results = yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          if (!row.access_token) return "failed" as const;
          const adapter = registry.get(row.platform);
          if (!adapter?.getAccountAnalytics) return "skipped" as const;
          const context: ProviderRequestContext = {
            operationId: `account-analytics:${row.id}:${Date.now()}`,
            requestId: `account-analytics:${row.id}`,
          };
          const execution = yield* executeProviderAccountAnalyticsEffect(
            registry,
            context,
            {
              connectionStatus: row.connection_status,
              platform: row.platform,
              providerAccountId: row.platform_user_id,
              storedAccessToken: row.access_token,
              tokenExpiresAt: row.token_expires_at === null ? null : new Date(row.token_expires_at),
            },
            { decryptToken },
          ).pipe(Effect.provide(createProviderServiceLive(registry)));
          if (execution.outcome === "failure") return "failed" as const;
          const account: ProviderAccountAnalytics = execution.account;
          yield* repository.recordSnapshot({
            capturedAt: account.recordedAt,
            followers: account.followers,
            following: account.following ?? null,
            orgId: row.org_id,
            platformAccountId: row.id,
            posts: account.posts ?? null,
          });
          return "recorded" as const;
        }).pipe(
          Effect.catch((cause) => {
            log(
              "warn",
              {
                environment: env.ENVIRONMENT,
                job_id: row.id,
                service: "automation",
                trace_id: row.id,
                version: env.VERSION,
              },
              {
                ...errorDiagnostic(cause),
                event: "account_analytics_failed",
                job: "account_analytics_sweep",
                outcome: "failed",
                platform: row.platform,
                platform_account_id: row.id,
                retry_class: "none",
              },
            );
            return Effect.succeed("failed" as const);
          }),
        ),
      { concurrency: 4 },
    );

    return {
      failed: results.filter((result) => result === "failed").length,
      recorded: results.filter((result) => result === "recorded").length,
      scanned: rows.length,
    };
  }).pipe(Effect.mapError(classifyJobError));
}
