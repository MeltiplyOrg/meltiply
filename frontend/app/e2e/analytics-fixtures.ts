import { randomUUID } from "node:crypto";
import { Pool } from "pg";

/**
 * One published destination in the analytics browser fixture.
 *
 * `snapshot` omitted models a Distribution that has not synced yet; the UI must
 * render its metric cells as awaiting sync rather than a measured zero.
 */
interface CohortDistribution {
  daysAgo: number;
  platform: string;
  snapshot?: { comments: number; likes: number; shares: number; views: number };
}

/**
 * Deterministic analytics values; each fixture run allocates independent identities
 * because browser journeys and retries share one Workspace.
 */
const posts: readonly { distributions: readonly CohortDistribution[]; title: string }[] = [
  {
    title: "Analytics E2E launch",
    distributions: [
      {
        daysAgo: 3,
        platform: "instagram",
        snapshot: { comments: 6, likes: 60, shares: 3, views: 600 },
      },
      {
        daysAgo: 3,
        platform: "threads",
        snapshot: { comments: 2, likes: 20, shares: 1, views: 200 },
      },
      { daysAgo: 3, platform: "tiktok", snapshot: { comments: 0, likes: 1, shares: 0, views: 10 } },
    ],
  },
  {
    title: "Analytics E2E TikTok only",
    distributions: [
      { daysAgo: 4, platform: "tiktok", snapshot: { comments: 0, likes: 5, shares: 0, views: 50 } },
    ],
  },
  {
    title: "Analytics E2E awaiting",
    distributions: [{ daysAgo: 2, platform: "instagram" }],
  },
  {
    title: "Analytics E2E older",
    distributions: [
      {
        daysAgo: 20,
        platform: "instagram",
        snapshot: { comments: 9, likes: 90, shares: 4, views: 900 },
      },
    ],
  },
  ...[500, 440, 380, 320, 260, 200, 140, 80].map((views, index) => ({
    title: `Analytics E2E cohort ${index + 5}`,
    distributions: [
      {
        daysAgo: 2,
        platform: "instagram",
        snapshot: { comments: 2, likes: views / 10, shares: 1, views },
      },
    ],
  })),
];

/**
 * Inserts a deterministic analytics cohort for one isolated owner Brand Profile.
 *
 * The default local stack and the controlled acceptance stack both read stored
 * snapshots, not live provider counters, so the browser journey owns its
 * published history directly. The fixture deliberately includes:
 * - a Post with Instagram, Threads, and TikTok destinations (partial coverage),
 * - a Post on an unsupported Platform only,
 * - a published Post whose first snapshot has not arrived,
 * - one Post older than the 7-day preset but inside the default 30-day window,
 * - enough Posts for the initial ten-row page to report more.
 *
 * @param profileName - Active Brand Profile display name created by the journey.
 * @returns The seeded Post count and the profile id used for cleanup assertions.
 * @throws When the database is not the dedicated local test database or the
 *   profile cannot be resolved.
 */
export async function seedAnalyticsCohort(profileName: string): Promise<{ profileId: string }> {
  const connectionString = process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL;
  if (!connectionString?.trim()) {
    throw new Error("MELTIPLY_DATABASE_TEST_ADMIN_URL is required for analytics fixtures");
  }
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/meltiply") {
    throw new Error("Analytics fixtures require the dedicated loopback test database");
  }
  const pool = new Pool({ connectionString });
  try {
    const profile = await pool.query<{ id: string; org_id: string }>(
      `SELECT id::text AS id, org_id::text AS org_id
         FROM brand_profiles
        WHERE name = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [profileName],
    );
    const owner = profile.rows[0];
    if (!owner) throw new Error(`No active Brand Profile named ${profileName}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [postIndex, post] of posts.entries()) {
        const postId = randomUUID();
        await client.query(
          `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
           VALUES ($1, $2, $3, $4, $5, 'active')`,
          [
            postId,
            owner.org_id,
            owner.id,
            post.title,
            `${post.title} is a deterministic analytics fixture with enough text to exercise the row identity.`,
          ],
        );
        for (const [distributionIndex, distribution] of post.distributions.entries()) {
          const distributionId = randomUUID();
          const publishedAt = new Date(
            Date.now() - distribution.daysAgo * 24 * 60 * 60 * 1_000,
          ).toISOString();
          await client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status,
                published_at, platform_post_id)
             VALUES ($1, $2, $3, $4, $5, 'published', $6, $7)`,
            [
              distributionId,
              owner.org_id,
              owner.id,
              postId,
              distribution.platform,
              publishedAt,
              `analytics-e2e-${postIndex}-${distributionIndex}`,
            ],
          );
          if (distribution.snapshot) {
            await client.query(
              `INSERT INTO analytics_snapshots
                 (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
               VALUES ($1, $2, $3, $4, $5, $6, now() - INTERVAL '1 hour')`,
              [
                distributionId,
                owner.org_id,
                distribution.snapshot.views,
                distribution.snapshot.likes,
                distribution.snapshot.comments,
                distribution.snapshot.shares,
              ],
            );
          }
        }
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    return { profileId: owner.id };
  } finally {
    await pool.end();
  }
}
