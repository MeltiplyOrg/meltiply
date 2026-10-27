import { Schema } from "effect";
import { PLATFORM_IDS, type DistributionStatus } from "@meltiply/domain";
import { previewObjectSchema, type PreviewObject, type PreviewOperation } from "./contract-types";
import { mergeExample } from "./values";

const epoch = Date.parse("2026-01-01T00:00:00Z");
const day = 86_400_000;
const outcomes: readonly DistributionStatus[] = [
  "scheduled",
  "published",
  "queued",
  "published",
  "processing",
  "awaiting_provider",
  "published",
  "published",
  "failed",
  "cancel_requested",
  "cancelled",
  "needs_reconciliation",
];
const topics = [
  "Launch announcement",
  "Behind the scenes",
  "Product walkthrough",
  "Community highlights",
  "Weekly recap",
  "Questions and answers",
];

/** Decodes a canonical JSON object at the mock-data boundary; missing templates fail rather than silently producing incomplete records. */
function object(value: unknown): PreviewObject {
  return Schema.decodeUnknownSync(previewObjectSchema)(value);
}

/** Makes stable UUIDs without changing the canonical first record's identity; resource families never collide. */
function identity(template: PreviewObject, family: number, index: number): string {
  return index === 0 && typeof template.id === "string"
    ? template.id
    : `00000000-0000-4000-8000-${String(family * 10000 + index).padStart(12, "0")}`;
}

/** Produces dates relative to the canonical epoch; scenario hydration moves the entire workspace together near today. */
function date(offset: number): string {
  return new Date(epoch + offset * day).toISOString();
}

/** Expands existing examples into a deterministic editorial workspace, not another seed catalog. All response-only fields are inherited from canonical templates; only content, relationships, dates, counters, and lifecycle outcomes vary. */
export function populatePreviewWorkspace(
  source: PreviewOperation[],
  fixtures: PreviewObject,
): PreviewOperation[] {
  const operations = structuredClone(source);
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  /** Reads an operation's canonical successful body; absent operations are a contract integration error. */
  function body(id: string): PreviewObject {
    return object(byId.get(id)?.success.body);
  }
  /** Replaces only the fields being expanded, preserving newly added canonical response fields automatically. */
  function replace(id: string, patch: PreviewObject): void {
    const operation = byId.get(id);
    if (!operation) throw new Error(`Missing preview workspace operation: ${id}`);
    operation.success = { ...operation.success, body: { ...body(id), ...patch } };
  }
  const profileTemplate = object(fixtures.brand_profile);
  const accountTemplate = object(fixtures.account);
  const postTemplate = object(fixtures.post);
  const distributionTemplate = object(fixtures.distribution);
  const targetTemplate = object(fixtures.post_target);
  const assetTemplate = object(fixtures.asset);
  const queueTemplate = body("createQueue");
  const profiles: PreviewObject[] = ["Studio", "Community", "Fieldnotes"].map((name, index) => ({
    ...profileTemplate,
    id: identity(profileTemplate, 1, index),
    name: `${profileTemplate.name} · ${name}`,
  }));
  const capabilityRows = Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(
    body("listPlatformCapabilities").capabilities,
  );
  const accounts: PreviewObject[] = profiles.flatMap((profile, profileIndex) =>
    PLATFORM_IDS.map((platform, platformIndex) => ({
      ...accountTemplate,
      id: identity(accountTemplate, 2, profileIndex * PLATFORM_IDS.length + platformIndex),
      brand_profile_id: profile.id,
      platform,
      display_name: `${profile.name} · ${platform}`,
      username: platformIndex % 3 === 0 ? null : `preview.${profileIndex + 1}.${platform}`,
      platform_user_id: `preview-${platform}-${profileIndex + 1}`,
      connection_status: ["connected", "connected", "expiring", "expired", "reconnect_required"][
        (profileIndex + platformIndex) % 5
      ],
      capabilities: capabilityRows.find((capability) => capability.platform === platform) ?? {
        ...object(accountTemplate.capabilities),
        platform,
      },
    })),
  );
  const queues = profiles.map((profile, index) => ({
    ...queueTemplate,
    id: identity(queueTemplate, 3, index),
    brand_profile_id: profile.id,
    name: `${profile.name} · Weekly publishing`,
    slots: [1, 3, 5].map((weekday) => ({ weekday, time: index % 2 ? "14:00" : "09:30" })),
  }));
  const metricTemplate = object(body("getAnalyticsSummary").totals);
  const attachmentTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(postTemplate.attachments)[0],
  );
  const posts: PreviewObject[] = Array.from({ length: 72 }, (_, index) => {
    const profileIndex = Math.floor(index / topics.length) % profiles.length;
    const profile = profiles[profileIndex]!;
    const draft = index % 10 === 0;
    const status = outcomes[(index - 1 + outcomes.length) % outcomes.length]!;
    const published = !draft && status === "published";
    const scheduled = status === "scheduled" || status === "queued";
    const instant = date(
      published ? -(1 + (index % 21)) : scheduled ? 1 + (index % 14) : -(index % 7),
    );
    const id = identity(postTemplate, 4, index);
    const title = `${topics[index % topics.length]} · ${profile.name}`;
    const metrics = Object.fromEntries(
      Object.entries(metricTemplate)
        .filter(([key]) => !["post_count", "watch_time_sec"].includes(key))
        .map(([key, value]) => [key, typeof value === "number" ? value * (index + 1) : value]),
    );
    const analytics = { ...metrics, saves: null, clicks: null };
    const destinations = accounts
      .filter((account) => account.brand_profile_id === profile.id)
      .slice(index % PLATFORM_IDS.length, (index % PLATFORM_IDS.length) + 2);
    const aggregate = Object.fromEntries(
      Object.entries(analytics).map(([key, value]) => [
        key,
        typeof value === "number" ? value * destinations.length : value,
      ]),
    );
    const distributions = draft
      ? []
      : destinations.map((account, destinationIndex) => ({
          ...distributionTemplate,
          id: identity(distributionTemplate, 5, index * PLATFORM_IDS.length + destinationIndex),
          post_id: id,
          brand_profile_id: profile.id,
          platform_account_id: account.id,
          platform: account.platform,
          status,
          scheduled_at: instant,
          published_at: published ? instant : null,
          platform_post_id: published ? `preview-publication-${index}-${destinationIndex}` : null,
          attempt_count: published || status === "failed" ? 1 : 0,
          last_attempt_at: published || status === "failed" ? instant : null,
          failure:
            status === "failed" || status === "needs_reconciliation"
              ? {
                  code: "preview_provider_failure",
                  message:
                    "Synthetic Provider response: reconnect the Channel or retry this publication.",
                  retryable: status === "failed",
                  last_occurred_at: instant,
                }
              : null,
        }));
    const asset = {
      ...assetTemplate,
      id: identity(assetTemplate, 6, index),
      brand_profile_id: profile.id,
      title,
    };
    return {
      ...postTemplate,
      id,
      title,
      default_text: `${topics[index % topics.length]} #${index + 1}\n\n${profile.description}\n\nA preview of our ${String(topics[(index + 1) % topics.length]).toLowerCase()}: the details, the people, and what comes next.`,
      brand_profile_id: profile.id,
      status: draft ? "draft" : "active",
      attachments:
        index % 4 === 3
          ? []
          : [
              {
                ...attachmentTemplate,
                asset_id: asset.id,
                asset,
              },
            ],
      targets: destinations.map((account) => ({
        ...targetTemplate,
        platform_account_id: account.id,
      })),
      distributions,
      analytics: published ? aggregate : null,
      distribution_analytics: published
        ? distributions.map((distribution) => ({
            distribution_id: distribution.id,
            platform_account_id: distribution.platform_account_id,
            platform: distribution.platform,
            analytics,
          }))
        : [],
      queue_membership:
        scheduled && !draft
          ? {
              queue_id: queues[profileIndex]!.id,
              queue_name: queues[profileIndex]!.name,
              assigned_at: instant,
            }
          : null,
      created_at: date(-28 + index / 4),
      updated_at: date(-index / 72),
    };
  });
  replace("listBrandProfiles", { profiles });
  replace("listPlatformAccounts", { accounts });
  replace("listQueues", { items: queues });
  replace("listPosts", { posts, has_more: true });
  replace("listDistributions", {
    distributions: posts.flatMap((post) =>
      Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(post.distributions),
    ),
  });
  const eventTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(
      body("listCalendarEvents").events,
    )[0],
  );
  replace("listCalendarEvents", {
    events: posts.flatMap((post) =>
      Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(post.distributions).map(
        (distribution) => ({
          ...eventTemplate,
          id: distribution.id,
          post_id: post.id,
          post_title: post.title,
          brand_profile_id: post.brand_profile_id,
          platform: distribution.platform,
          platform_account_id: distribution.platform_account_id,
          status: distribution.status,
          scheduled_at: distribution.scheduled_at,
          published_at: distribution.published_at,
          updated_at: post.updated_at,
        }),
      ),
    ),
  });
  const published = posts.filter((post) => post.analytics !== null);
  const snapshots: PreviewObject[] = published.flatMap((post) =>
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(post.distribution_analytics).map(
      (snapshot) => ({
        ...snapshot,
        published_at: Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(
          post.distributions,
        )[0]?.published_at,
      }),
    ),
  );
  /** Aggregates generated per-Channel counters, so cohort and platform totals agree with the same published snapshots. Untracked values retain their canonical defaults. */
  function aggregateMetrics(rows: PreviewObject[]): PreviewObject {
    return Object.fromEntries(
      Object.entries(metricTemplate).map(([key, fallback]) => [
        key,
        key === "post_count"
          ? rows.length
          : typeof fallback === "number"
            ? rows.reduce((sum, row) => {
                const value = object(row.analytics)[key];
                return sum + (typeof value === "number" ? value : 0);
              }, 0)
            : fallback,
      ]),
    );
  }
  const totals = aggregateMetrics(snapshots);
  const summary = body("getAnalyticsSummary");
  const platformTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(summary.by_platform)[0],
  );
  const byPlatform: PreviewObject[] = PLATFORM_IDS.map((platform) => ({
    ...platformTemplate,
    ...aggregateMetrics(snapshots.filter((snapshot) => snapshot.platform === platform)),
    platform,
    last_synced_at: date(-0.1),
  }));
  replace("getAnalyticsSummary", {
    totals,
    by_platform: byPlatform,
    range: { start: date(-28), end: date(0) },
    last_synced_at: date(-0.1),
  });
  const rankedTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(body("getAnalyticsPosts").posts)[0],
  );
  replace("getAnalyticsPosts", {
    posts: published.map((post) =>
      mergeExample(rankedTemplate, {
        ...object(post.analytics),
        post_id: post.id,
        title: post.title,
        excerpt: post.default_text,
        published_at:
          Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(post.distributions)[0]
            ?.published_at ?? date(-1),
        platforms: Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(
          post.distributions,
        ).map((distribution) => distribution.platform),
        last_synced_at: date(-0.1),
      }),
    ),
  });
  const dashboard = body("getAnalyticsDashboard");
  const seriesTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(dashboard.series)[0],
  );
  const series = Array.from({ length: 28 }, (_, index) =>
    PLATFORM_IDS.map((platform) => {
      const day = date(index - 27).slice(0, 10);
      const metrics = aggregateMetrics(
        snapshots.filter(
          (snapshot) =>
            snapshot.platform === platform &&
            typeof snapshot.published_at === "string" &&
            snapshot.published_at.startsWith(day),
        ),
      );
      return {
        ...Object.fromEntries(
          Object.entries(seriesTemplate).map(([key, value]) => [key, metrics[key] ?? value]),
        ),
        posts: metrics.post_count,
        date: day,
        platform,
        last_synced_at: date(-0.1),
      };
    }),
  ).flat();
  const followersTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(dashboard.followers)[0],
  );
  const pointTemplate = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(followersTemplate.points)[0],
  );
  const platformMetrics = object(
    Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(dashboard.platforms)[0],
  );
  replace("getAnalyticsDashboard", {
    range: { start: date(-28), end: date(0) },
    series,
    cohort: { ...object(dashboard.cohort), ...body("getAnalyticsSummary") },
    platforms: byPlatform.map((metrics, index) => ({
      ...Object.fromEntries(
        Object.entries(platformMetrics).map(([key, value]) => [key, metrics[key] ?? value]),
      ),
      posts: metrics.post_count,
      followers: 1200 * (index + 1),
      follower_gain: 80 * (index + 1),
      last_synced_at: date(-0.1),
    })),
    followers: accounts.slice(0, PLATFORM_IDS.length).map((account, accountIndex) => ({
      ...followersTemplate,
      platform: account.platform,
      account_id: account.id,
      account_name: account.display_name,
      points: Array.from({ length: 28 }, (_, index) => ({
        ...pointTemplate,
        captured_at: date(index - 27),
        followers: 1200 * (accountIndex + 1) + index * (9 + accountIndex),
      })),
    })),
  });
  for (const [operationId, field, templateName, count] of [
    ["listWorkspaceMembers", "members", "workspace_member", 8],
    ["listWorkspaceInvitations", "invitations", "workspace_invitation", 4],
    ["listWorkspaceAudit", "entries", "audit_entry", 24],
  ] as const) {
    if (!byId.has(operationId)) continue;
    const template = object(fixtures[templateName]);
    const items = Array.from({ length: count }, (_, index) => ({
      ...template,
      ...(typeof template.id === "string"
        ? { id: identity(template, 7 + count, index) }
        : { user_id: identity({ id: template.user_id }, 7 + count, index) }),
      ...(typeof template.email === "string" ? { email: `preview-${index + 1}@example.test` } : {}),
      ...(typeof template.display_name === "string"
        ? { display_name: `Preview contributor ${index + 1}` }
        : {}),
      created_at: date(-index),
    }));
    replace(operationId, { [field]: items });
  }
  return operations;
}
