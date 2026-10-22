# Analytics page specification

Status: ready for implementation
Date: 2026-10-19
Contract change: approved in conversation on 2026-10-19

> Implementation note (2026-10-19): the owner later required analytics for
> every supported Provider, so Facebook Page Reels, TikTok videos, and YouTube
> videos now expose stored analytics too. The Instagram/Threads-only coverage
> and provider out-of-scope statements below describe the initial spec and are
> superseded by the capability inventory and the shipped Provider adapters.
> Implementation note (2026-10-22): extended to the full 12-chart Social
> Media Analytics Dashboard per graph requirements. Adds additive
> `/analytics/dashboard` endpoint, account-level follower snapshots via
> `platform_account_snapshots` (migration 013), content format breakdowns from
> frozen attachments, 7x24 publication heatmaps, time series with period deltas,
> frequency-vs-engagement scatter, engagement accumulation, and shared filters
> for account and content format. Saves, clicks, and missing follower histories
> are labeled "Not tracked" / unavailable rather than fabricated as zero.
> Implementation note (2026-10-22, feedback revision): the dashboard now fills
> the available width instead of a centered 1200px column. The toolbar carries
> filters only (range, platform, account, format) and no longer switches a global
> metric mode: the platform comparison and time-series cards render one small
> multiple per stored metric, the engagement trend always shows likes, comments,
> and shares, and the top-Posts table keeps all metric columns visible with
> header re-ranking. Chart-local selectors use the shared sliding segmented
> control. Tables declare explicit column widths so headers and state labels no
> longer clip.
> Implementation note (2026-10-22, density revision): the dashboard is reduced
> from ten chart cards to five single-plot charts. Nested small multiples are
> gone: the platform comparison is one stacked likes/comments/shares bar chart
> (views and posts in its tooltip and hidden table), and the time series is one
> indexed multi-series line chart (cumulative change rebased to 100 at the first
> measured period, absolute values on hover). The posts-per-platform card, the
> posting-frequency scatter, and the engagement-accumulation chart are no longer
> rendered; the dashboard endpoint still returns their data. The content-format
> card shows posts, per-post averages, and totals together without a metric
> selector. Saves/clicks columns appear only when a provider reports them,
> otherwise a footnote names them as untracked.
> Implementation note (2026-10-22, toolbar revision): the analytics toolbar now
> uses the shared collection filter builder from Posts. One Filter disclosure
> holds the range, platform, account, and format fields; active values become
> removable chips with a Clear all action, and Refresh remains beside the
> builder. The four always-visible selects are gone, and the row wraps instead
> of scrolling horizontally.

## 1. Summary

Add a dedicated `/analytics` workspace route and sidebar section. The page is a
read-only, Brand Profile-scoped overview of performance for published Posts:
KPI totals, a platform comparison chart when at least two supported platforms
have stored snapshots, and a ranked Post table. It uses the
existing analytics snapshots already synced by the automation worker; it does not
add provider sync, new metrics, or fabricated data.

The page uses EvilCharts with its Recharts engine for the platform comparison
chart. No aggregate trend line is included in this version because the existing
API has no aggregate time-series endpoint and snapshots older than 90 days are
trimmed except each Distribution's latest value.

## 2. Decisions

| Area                | Decision                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary job         | Answer which platforms and Posts are earning attention, not publishing health or per-Post forensics.                                                                                                         |
| Scope               | Read-only, single-owner workspace, respects the active Brand Profile; "All Brand Profiles" is the aggregate.                                                                                                 |
| Range semantics     | Cohort: Posts published in the selected range, with each Distribution's latest snapshot at or before the range end. The UI must say so.                                                                      |
| Metrics             | Views, likes, comments, shares, and published destinations. No reach, impressions, watch time, or derived engagement rate.                                                                                   |
| Surfaces            | KPI totals, platform comparison bar chart when two or more supported platforms have snapshots, top-Posts table. No trend, demographics, follower growth, link clicks, AI insights, export, or email reports. |
| Data-honesty states | Show last sync, unsupported platforms, and platforms awaiting first sync. Never render an unsupported metric as zero.                                                                                        |
| Posts surface       | Analytics lives only on `/analytics`. Do not restore metrics in the Posts list, grid, calendar, or detail dialog.                                                                                            |
| Contract            | Extend the OpenAPI contract with `getAnalyticsPosts` and additive per-platform/per-row sync timestamps.                                                                                                      |
| Charting            | EvilCharts Recharts bar chart, vendored from its shadcn registry, colored with existing CSS tokens.                                                                                                          |
| Navigation          | New top-level item in the order Posts, Analytics, Channels.                                                                                                                                                  |
| URL state           | `?range=7d\|30d\|90d\|366d`, `?platform=<platform>`, `?metric=views\|likes\|comments\|shares`. Brand Profile remains global.                                                                                 |

## 3. Non-goals

- Audience demographics, follower growth, link clicks, saves, or any metric the
  current provider adapters do not return.
- Daily or hourly trend charts, period-over-period comparison, or forecasting.
- Per-Post analytics history, a per-Distribution drill-down, or metrics in the
  Posts surface.
- Real-time updates, polling, webhooks, CSV export, scheduled email reports, or
  an alerting workflow.
- Provider work to populate reach, impressions, or watch time for Instagram or
  Threads. Those fields stay out of the page until a provider actually reports
  them.
- Custom start/end date pickers. The page offers the four fixed ranges above.

## 4. User experience

### 4.1 Route and navigation

- Add `analytics` to the `WorkspaceView` union in
  `frontend/app/src/components/primitives/sidebar-nav.tsx`.
- Add a `WORKSPACE_NAV_ITEMS` entry with `path: "/analytics"`, label `Analytics`,
  the shared `AnimatedBarChart` icon, and `BarChart3` for the mobile drawer.
  Order the list Posts, Analytics, Channels.
- Add the lazy route in `frontend/app/src/app-router.tsx`:
  `frontend/app/src/app/(dashboard)/analytics/page.tsx`.
- Add the route importer to `frontend/app/src/lib/preload-routes.ts`.
- The route is lazy-loaded. Recharts and the vendored chart source must not enter
  the Posts or Channels chunks.

### 4.2 Page layout

Use `WorkspaceSurface` for the page frame:

- Title: `Analytics`
- Description: `Performance for published posts across connected channels.`
- Actions: refresh button and last-sync label.

Below the header:

1. **Toolbar** (`TopToolbar`): range select, platform select, metric segmented
   control, refresh button.
2. **KPI row**: Views, Likes, Comments, Shares, Published destinations.
3. **Platform comparison** card: EvilCharts horizontal bar chart of the selected
   metric by platform. Omitted for a single Platform filter or when fewer than
   two supported platforms have a stored snapshot; one platform has nothing to
   compare.
4. **Top Posts** card: table of the ten highest Posts for the selected metric,
   with a Load more action when the API reports more rows.

### 4.3 Toolbar

- Range select options: Last 7 days (`7d`), Last 30 days (`30d`, default), Last
  90 days (`90d`), Last 12 months (`366d`).
- Platform select: All platforms, plus only platforms whose capability reports
  `analytics: true`. Use the existing platform capability query. If none support
  analytics, disable the select and show the no-capable-channel state.
- Metric segmented control: Views (`views`, default), Likes (`likes`), Comments
  (`comments`), Shares (`shares`). It controls the chart and the Post ranking.
- Refresh button: re-reads stored snapshots only. It does not trigger a provider
  sync. Its tooltip must say: `Reloads stored metrics. Provider syncing runs on its own schedule.`
- The toolbar scrolls horizontally on narrow screens rather than wrapping or
  hiding controls.

### 4.4 KPI cards

Each card shows a label, the exact integer with thousands separators, and a
short definition on hover/focus:

| Card                   | Value                   | Definition                                                                          |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| Views                  | Sum of latest snapshots | Views reported for Posts published in this range.                                   |
| Likes                  | Sum of latest snapshots | Likes reported for those Posts.                                                     |
| Comments               | Sum of latest snapshots | Comments reported for those Posts.                                                  |
| Shares                 | Sum of latest snapshots | Shares, reposts, and quotes reported for those Posts.                               |
| Published destinations | `totals.post_count`     | One Post can publish to multiple Channels; each published Distribution counts once. |

No percentage, delta, or target is shown. Do not compute an engagement rate.

### 4.5 Platform comparison chart

- EvilCharts Recharts horizontal bar chart, shown only for the All platforms
  aggregate with at least two supported platforms holding a snapshot. A single
  Platform filter or a one-platform cohort omits the card immediately instead of
  rendering a single bar against empty space.
- Bars are sorted by the selected metric descending, capped at a slim 28px
  thickness, and labeled with their exact value. The chart height follows the
  number of bars instead of reserving a fixed large canvas.
- One bar per supported platform with at least one published destination and at
  least one snapshot (`last_synced_at !== null`).
- Value: the selected metric from `by_platform`.
- Platform names are visible labels. Tooltip shows the platform, metric, and
  published-destination count.
- Supported platforms with `post_count > 0` and `last_synced_at === null` are
  listed below the chart as `Awaiting first sync: Instagram, Threads`.
- The chart exposes a visually hidden table with the same platform, metric, and
  destination-count values. The chart container has `role="img"` and an
  `aria-label` that summarizes the selected metric and range.
- Under the shared low-motion preference, pass `animationType="none"`.
- Use `var(--accent)` for the bar series. Do not hardcode EvilCharts' example
  hex colors.

### 4.6 Top Posts table

Columns:

| Column    | Content                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Post      | `title` when non-empty, else `excerpt`; show `excerpt` as a secondary line when both exist. Empty title and excerpt render `Untitled post`. |
| Platforms | Provider icons plus destination count. Use the existing platform identity components.                                                       |
| Published | Earliest `published_at` among the Post's included Distributions, relative time with the exact timestamp in `title`.                         |
| Views     | Exact integer, or `Not supported`, or `Awaiting sync`.                                                                                      |
| Likes     | Same rules.                                                                                                                                 |
| Comments  | Same rules.                                                                                                                                 |
| Shares    | Same rules.                                                                                                                                 |

- Rows are sorted by the selected metric descending, then `published_at`
  descending, then `post_id` ascending.
- Metric column headers are buttons that switch the selected metric. The active
  column shows the sort indicator.
- When a row has some unsupported platforms and some supported platforms, show a
  `Partial` badge next to the metric values and use the full sum.
- When every platform on a row is unsupported, render every metric cell as
  `Not supported` and do not show zero.
- When a row has no snapshots yet (`last_synced_at === null`), render metric
  cells as `Awaiting sync`, not zero.
- Initial limit is 10. Load more increases the limit by 10 up to 50 and refetches
  the top N; the UI does not implement offset paging. The API still supports
  offset for future consumers.
- On narrow screens, render each Post as a stacked row with labels; do not force
  horizontal page scrolling. The table may scroll internally only if needed.

### 4.7 States

| State                               | Trigger                                                                                | Treatment                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Loading                             | First summary or Post query fetch                                                      | Skeleton matching KPI, chart, and table geometry.                                                     |
| Refreshing                          | A range, platform, metric, or profile change with prior data                           | Keep prior data visible; show a subtle busy state on the refresh control.                             |
| Error                               | Either query rejects                                                                   | Shared `Alert` with the error message and a Retry button. The page header remains visible.            |
| No capable channels                 | No connected platform has `analytics: true`                                            | Empty state: `Analytics needs a connected channel that reports analytics.` with a link to Channels.   |
| No published Posts                  | `totals.post_count === 0`                                                              | Empty state: `No published posts in this range.`                                                      |
| All published platforms unsupported | `post_count > 0`, `partial`, and every `by_platform` row is unsupported                | Empty state: `No analytics-capable published destinations in this range.`                             |
| Awaiting first sync                 | Published destinations exist but every included platform has `last_synced_at === null` | Empty state: `Metrics appear after the first provider sync.` with the last-sync label when available. |

### 4.8 Labels that prevent misreading

- The range description must read:
  `Published {range label} · measured as of {end}`.
- A caption under the KPI row must read:
  `Metrics are cumulative snapshots for posts published in this range, not activity during it.`
- The active Brand Profile name, or `All Brand Profiles`, appears in the page
  description or toolbar. Do not add a second profile selector.

## 5. Data semantics

### 5.1 Cohort and aggregation

For a requested `[start, end]`:

1. Select Distributions with `status = 'published'` and
   `published_at BETWEEN start AND end`.
2. Apply the optional `platform` and `brand_profile_id` filters.
3. Exclude soft-deleted Brand Profiles.
4. For each selected Distribution, take the latest `analytics_snapshots` row with
   `snapshot_at <= end`, ordered by `snapshot_at DESC, id DESC`.
5. Sum the `views`, `likes`, `comments`, and `shares` of those latest snapshots.
6. Group by platform for `by_platform`; group by Post for the Posts table.

Consequences that must be stated in the UI:

- A Post published before `start` is excluded even if it still receives
  engagement during the range.
- A Post published inside the range contributes its cumulative metrics as of
  `end`, not the change since `start`.
- Multiple Distributions of one Post are summed. `post_count` counts published
  Distributions, not Posts.
- Analytics sync stops after 366 days, so a Distribution older than that has no
  newer snapshots. Its latest retained snapshot still contributes.
- The page does not bucket by day, so no workspace timezone setting is required.
  Range boundaries are rolling UTC instants.

### 5.2 Published timestamp invariant

`published_at` is the cohort timestamp. A Distribution with `status = 'published'`
must have a non-null `published_at`; the existing publication paths set it when
the status becomes `published`. Add a regression test that asserts this invariant
for published fixtures. If a legacy row is null, it is excluded from analytics
rather than silently falling back to `scheduled_at` or `created_at`.

### 5.3 Unsupported platforms and freshness

- `unsupported_platforms` is the distinct set of platforms among the selected
  published Distributions whose provider capability has `analytics: false`.
- `partial` is `unsupported_platforms.length > 0`.
- This replaces the current behavior, which considers all five registered
  platforms and therefore reports `partial: true` even when the workspace has no
  distribution on an unsupported platform.
- `last_synced_at` on the summary remains the maximum snapshot timestamp across
  the response. Per-platform and per-Post `last_synced_at` are added so "never
  synced" is distinguishable from a measured zero.
- The UI shows a freshness warning when `last_synced_at` is older than 26 hours,
  the daily sync cadence plus margin. It always shows the exact timestamp. It
  does not attempt to infer age-dependent cadence.

## 6. API changes

### 6.1 Existing summary endpoint

`GET /api/v1/analytics` keeps its path, parameters, and response shape, with two
semantic fixes and one additive field:

- Filter candidates with `published_at`, not `event_at`.
- Derive `unsupported_platforms` and `partial` from the selected published
  Distributions only.
- Add nullable `last_synced_at` to each `PlatformMetrics` row.

`post_count` keeps its name and means the number of published Distributions in
the group. The UI labels it `Published destinations`.

### 6.2 New endpoint

`GET /api/v1/analytics/posts`

Operation ID: `getAnalyticsPosts`

Query parameters:

| Parameter          | Type                                        | Rules                                                      |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| `start`            | date-time                                   | Required. Must be before `end`.                            |
| `end`              | date-time                                   | Required. Range at most 366 days.                          |
| `platform`         | Platform                                    | Optional.                                                  |
| `brand_profile_id` | UUID                                        | Optional. Omitted means the read-only workspace aggregate. |
| `metric`           | enum `views`, `likes`, `comments`, `shares` | Optional, default `views`. Controls ranking.               |
| `limit`            | integer                                     | Optional, default 10, minimum 1, maximum 100.              |
| `offset`           | integer                                     | Optional, default 0, minimum 0.                            |

Response:

```json
{
  "posts": [
    {
      "post_id": "00000000-0000-4000-8000-000000000000",
      "title": "Launch notes",
      "excerpt": "The short version of the caption.",
      "published_at": "2026-10-01T12:00:00Z",
      "destination_count": 2,
      "platforms": ["instagram", "threads"],
      "unsupported_platforms": [],
      "last_synced_at": "2026-10-01T12:15:00Z",
      "views": 1200,
      "likes": 84,
      "comments": 12,
      "shares": 9
    }
  ],
  "has_more": false,
  "limit": 10,
  "offset": 0
}
```

Rules:

- `title` is the Post title, possibly empty.
- `excerpt` is the first 140 characters of `default_text` with whitespace
  collapsed, possibly empty.
- `published_at` is the earliest `published_at` among the included Distributions.
- `destination_count` is the number of included Distributions.
- `platforms` is the sorted distinct platform list.
- `unsupported_platforms` is the subset of `platforms` whose capability has
  `analytics: false`.
- `last_synced_at` is the latest snapshot timestamp among the included
  Distributions, or null when none exist.
- Metrics are sums of the latest snapshot per included Distribution, as of
  `end`. Distributions without a snapshot contribute zero to the sums but still
  count as destinations and render as awaiting sync in the UI.
- Ranking: selected metric descending, then `published_at` descending, then
  `post_id` ascending.
- `has_more` is determined by fetching `limit + 1` rows.
- Soft-deleted Posts and Brand Profiles are excluded. Tenant and RLS boundaries
  apply through the existing tenant transaction helper.
- Errors: `400` for a reversed range, an over-366-day range, an invalid metric,
  or invalid pagination; `401` for an unauthenticated request.

### 6.3 SQL sketch

Summary candidates:

```sql
WITH candidates AS (
  SELECT d.id, d.platform
  FROM distributions d
  WHERE d.status = 'published'
    AND d.published_at >= $1
    AND d.published_at <= $2
    AND ($3::text IS NULL OR d.platform = $3)
    AND ($4::uuid IS NULL OR d.brand_profile_id = $4)
    AND activeBrandProfilePredicate('d.brand_profile_id')
),
latest AS (
  SELECT DISTINCT ON (s.distribution_id)
    s.distribution_id, s.views, s.likes, s.comments, s.shares,
    s.watch_time_sec, s.reach, s.impressions, s.snapshot_at
  FROM analytics_snapshots s
  JOIN candidates c ON c.id = s.distribution_id
  WHERE s.snapshot_at <= $2
  ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
)
SELECT
  c.platform,
  COALESCE(SUM(l.views), 0) AS views,
  COALESCE(SUM(l.likes), 0) AS likes,
  COALESCE(SUM(l.comments), 0) AS comments,
  COALESCE(SUM(l.shares), 0) AS shares,
  COALESCE(SUM(l.watch_time_sec), 0) AS watch_time_sec,
  COALESCE(SUM(l.reach), 0) AS reach,
  COALESCE(SUM(l.impressions), 0) AS impressions,
  COUNT(*) AS post_count,
  MAX(l.snapshot_at) AS last_synced_at
FROM candidates c
LEFT JOIN latest l ON l.distribution_id = c.id
GROUP BY c.platform
ORDER BY c.platform ASC;
```

Posts:

```sql
WITH candidates AS (
  SELECT d.id AS distribution_id, d.post_id, d.platform, d.published_at
  FROM distributions d
  WHERE d.status = 'published'
    AND d.published_at >= $1
    AND d.published_at <= $2
    AND ($3::text IS NULL OR d.platform = $3)
    AND ($4::uuid IS NULL OR d.brand_profile_id = $4)
    AND activeBrandProfilePredicate('d.brand_profile_id')
),
latest AS (
  SELECT DISTINCT ON (s.distribution_id)
    s.distribution_id, s.views, s.likes, s.comments, s.shares, s.snapshot_at
  FROM analytics_snapshots s
  JOIN candidates c ON c.distribution_id = s.distribution_id
  WHERE s.snapshot_at <= $2
  ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
),
per_post AS (
  SELECT
    c.post_id,
    MIN(c.published_at) AS published_at,
    COUNT(*) AS destination_count,
    ARRAY_AGG(DISTINCT c.platform ORDER BY c.platform) AS platforms,
    MAX(l.snapshot_at) AS last_synced_at,
    COALESCE(SUM(l.views), 0) AS views,
    COALESCE(SUM(l.likes), 0) AS likes,
    COALESCE(SUM(l.comments), 0) AS comments,
    COALESCE(SUM(l.shares), 0) AS shares
  FROM candidates c
  LEFT JOIN latest l ON l.distribution_id = c.distribution_id
  GROUP BY c.post_id
)
SELECT
  p.id AS post_id,
  p.title,
  LEFT(regexp_replace(p.default_text, '\s+', ' ', 'g'), 140) AS excerpt,
  pp.published_at,
  pp.destination_count,
  pp.platforms,
  pp.last_synced_at,
  pp.views,
  pp.likes,
  pp.comments,
  pp.shares
FROM per_post pp
JOIN posts p ON p.id = pp.post_id AND p.deleted_at IS NULL
ORDER BY
  CASE $5
    WHEN 'views' THEN pp.views
    WHEN 'likes' THEN pp.likes
    WHEN 'comments' THEN pp.comments
    WHEN 'shares' THEN pp.shares
  END DESC,
  pp.published_at DESC,
  pp.post_id ASC
LIMIT $6 OFFSET $7;
```

Implementation note: prefer a typed whitelist mapping in the service over the
`CASE` expression if it produces a clearer query plan. Never interpolate the
metric into SQL.

### 6.4 Index migration

Add `packages/database/migrations/012_analytics_page_indexes.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_distributions_org_published_at
  ON distributions (org_id, published_at, id)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_distributions_brand_profile_published_at
  ON distributions (brand_profile_id, published_at, id)
  WHERE status = 'published';
```

The existing analytics snapshot indexes already cover the latest-per-Distribution
join. Do not add columns or tables.

### 6.5 Contract artifacts

Update all of the following together:

- `packages/contracts/openapi.yaml`: the new path and schemas, plus the
  `PlatformMetrics.last_synced_at` field.
- `packages/contracts/examples/operations.yaml`: request and response examples.
- `packages/contracts/operation-readiness.json`: add `getAnalyticsPosts`.
- `packages/contracts/endpoint-readiness.md`: add the new row and update the
  existing analytics evidence.
- `packages/contracts/src/generated/schema.ts`: regenerate with
  `bun run contract:generate`; do not hand-edit.
- `packages/contracts/CHANGELOG.md`: record the additive contract change.
- Contract conformance and example tests.

## 7. Backend implementation

- Add the route in `workers/api/src/core-routes.ts` next to the existing
  analytics routes. Reuse `dateRange(..., 366)`, `platformParam`,
  `optionalBrandProfileParam`, and `integerParam`; add a small enum validator for
  `metric` if none exists.
- Add `analyticsPosts` to `workers/api/src/core-types.ts` and implement it in
  `workers/api/src/core-service.ts` with `withTenantTransactionEffect`.
- Extend the existing `summaryAnalytics` mapping with per-platform
  `last_synced_at` and the corrected unsupported-platform derivation.
- Reuse `number`, `isoDateTime`, and the existing capability registry. Do not add
  provider-specific branches.
- No Queue, sync, provider, or webhook changes.

Tests:

- Summary: `published_at` cohort (a Post scheduled earlier but published later
  falls in the publication window), platform filter, Brand Profile scope, soft
  delete exclusion, latest-snapshot selection, unsupported list derived from
  candidate platforms, `partial` false when all candidates support analytics.
- Posts: two Distributions of one Post aggregate into one row; one Platform
  filter; each metric ranking; tie-break order; `limit`/`offset`/`has_more`;
  empty result; unsnapped Distribution yields null `last_synced_at` and zero
  sums; soft-deleted Post and Brand Profile excluded; tenant isolation; reversed
  and over-366-day ranges rejected.
- Contract conformance for `getAnalyticsPosts` and the additive
  `last_synced_at` field.
- A published-Distribution invariant test asserting `published_at` is non-null.

## 8. Frontend implementation

### 8.1 Dependencies and vendored chart

- Add `recharts` `3.8.0` to `frontend/app/package.json`. EvilCharts currently
  targets that version.
- From `frontend/app`, run
  `bunx --bun shadcn@latest add @evilcharts/recharts-bar-chart` and inspect
  `resolvedPaths` first. Keep the generated registry files under
  `frontend/app/src/components/evilcharts/` so their canonical imports remain
  valid. Compose the actual chart in
  `frontend/app/src/components/analytics/platform-metric-chart.tsx`.
- Do not copy EvilCharts' example colors. Pass a `chartConfig` whose series color
  is `var(--accent)` for both light and dark themes.
- The chart source is large and is loaded only through the lazy analytics route.
- Verify the generated code under the app's lint and UI-ownership rules. If the
  registry writes into a retired local `components/ui` path, move the generated
  primitives under `components/evilcharts/` and update their imports; do not add
  a second canonical control.

### 8.2 Files

New app-local composition:

- `frontend/app/src/app/(dashboard)/analytics/page.tsx`
- `frontend/app/src/components/analytics/analytics-view.tsx`
- `frontend/app/src/components/analytics/analytics-toolbar.tsx`
- `frontend/app/src/components/analytics/metric-cards.tsx`
- `frontend/app/src/components/analytics/platform-metric-chart.tsx`
- `frontend/app/src/components/analytics/top-posts-table.tsx`
- `frontend/app/src/components/analytics/analytics-helpers.ts`
- component tests beside these files.

Modified app infrastructure:

- `frontend/app/src/app-router.tsx`
- `frontend/app/src/components/primitives/sidebar-nav.tsx`
- `frontend/app/src/lib/preload-routes.ts`
- `frontend/app/src/lib/api.ts`
- `frontend/app/src/lib/effect/api-client.ts`
- `frontend/app/src/lib/queries.ts`
- `frontend/app/src/types/index.ts`
- `frontend/app/src/lib/i18n.tsx`
- `frontend/app/package.json`

### 8.3 API client and queries

- Add types for `AnalyticsSummary`, `PlatformMetrics`, `AnalyticsPostRow`,
  `AnalyticsPostsResponse`, `AnalyticsMetric`, and `AnalyticsRangePreset`.
- Add `getAnalyticsSummary` and `getAnalyticsPosts` to `lib/api.ts`, following the
  `getCalendar` shape: workspace header, typed query params, abort signal.
- Add both methods to `ApiClientServiceShape` and its implementation.
- Add query keys:

```ts
analyticsSummary: (params?: AnalyticsQueryParams) =>
  params === undefined
    ? (["analytics", "summary"] as const)
    : (["analytics", "summary", normalizeParams(params)] as const),
analyticsPosts: (params?: AnalyticsPostsQueryParams) =>
  params === undefined
    ? (["analytics", "posts"] as const)
    : (["analytics", "posts", normalizeParams(params)] as const),
```

- Add `useAnalyticsSummary` and `useAnalyticsPosts`. Both merge
  `scope.brandProfileId` through `withBrandProfile`, gate on `scope.isSignedIn`,
  use `keepPreviousData`, and set `staleTime` to 60 seconds.
- No polling and no mutation invalidations. The refresh action invalidates both
  query prefixes.
- The query key excludes generated timestamps. Compute the `start`/`end` window
  inside each `queryFn` from the range preset so refetches use the current time
  without changing the cache key on every render.

### 8.4 URL state

- Parse `range`, `platform`, and `metric` from `useSearchParams`.
- Default to `range=30d`, `platform` absent (all), `metric=views`.
- Invalid values fall back to defaults without throwing.
- Write changes with React Router navigation so browser back/forward restores
  the previous view.
- Brand Profile is not a URL parameter; it comes from the global workspace scope.

### 8.5 Formatting and accessibility

- Use `Intl.NumberFormat` with standard grouping for exact values. If a KPI
  exceeds seven digits on a narrow screen, use compact notation and put the exact
  value in `title` and the accessible label.
- Relative dates use the existing formatting conventions; exact timestamps go in
  `title` and `dateTime`.
- Every metric must be understandable without color: labels, values, and
  `Not supported`/`Awaiting sync` text accompany platform colors.
- The chart's hidden table and the visible Post table are the accessible data
  alternatives.
- Focus rings, keyboard order, and reduced motion follow the shared UI
  contracts in [frontend-ui.md](../frontend-ui.md).
- Dialogs are not used on this page. If a later drill-down needs one, use
  `SideDialog` for a large inspection panel.

### 8.6 i18n

Reuse the existing analytics strings where they already match, including
`Analytics`, `Analytics could not be loaded`, `Analytics are partial`,
`Last synced {time}`, `Metrics are not supported for: {platforms}`,
`No platform metrics recorded in this range yet.`, and `Refresh analytics`.

Add and translate new keys for:

- `Performance for published posts across connected channels.`
- `Last 7 days`, `Last 90 days`, `Last 12 months`
- `Published destinations`
- `Metrics are cumulative snapshots for posts published in this range, not activity during it.`
- `Analytics needs a connected channel that reports analytics.`
- `No analytics-capable published destinations in this range.`
- `Metrics appear after the first provider sync.`
- `Awaiting first sync`
- `Awaiting sync`
- `Not supported`
- `Partial`
- `Load more`
- `Top posts`
- `Reloads stored metrics. Provider syncing runs on its own schedule.`
- `Published {range} · measured as of {end}`

Both English and Spanish catalog entries are required by the i18n parity test.

## 9. Documentation

- [frontend-capabilities.md](../frontend-capabilities.md): move Analytics from
  "Removed or intentionally absent" to "Retained surfaces" and describe the
  cohort semantics, supported platforms, and exclusions.
- [analytics.mdx](../../frontend/public/content/docs/analytics.mdx): replace the
  "no dashboard" text with the new route, supported metrics, range semantics,
  freshness behavior, and unsupported-platform explanation.
- [index.mdx](../../frontend/public/content/docs/index.mdx): update the Analytics
  entry description.
- [troubleshooting.mdx](../../frontend/public/content/docs/troubleshooting.mdx):
  remove the "no in-app analytics dashboard" claim and describe what to do when
  metrics are stale or unsupported.
- [channels.mdx](../../frontend/public/content/docs/channels.mdx): remove the
  line that says analytics are not advertised as an app workflow.
- [cookies.mdx](../../frontend/public/content/docs/cookies.mdx): update the line
  that says the app does not expose an Analytics page.
- [PRODUCT.md](../../PRODUCT.md): update the capability constraint that says
  backend analytics APIs do not imply a creator-facing surface.
- Contract readiness and changelog artifacts from section 6.5.

## 10. Verification

Run the smallest applicable checks during implementation and the full gate before
completion:

- `bun run contract:check` for the OpenAPI and generated-client changes.
- `bun run --filter './packages/*' --filter './workers/*' type-check`
  and the matching `test` command for the API changes.
- `bun run --filter frontend-app check` for type-check, lint, tests, and the
  production build.
- `bun run cloudflare:check` for the cross-cutting change.
- `bun run docs:links` after the documentation edits.

Browser smoke on the local stack with seeded data:

- Add published Instagram, Threads, Facebook, TikTok, and YouTube Distributions
  with snapshots to the local seed so the page has a supported-platform cohort.
  Keep an unaccepted Provider Distribution to exercise partial and not-supported
  states.
- Remove `/analytics` from the real-stack end-to-end retired-route list; it is a
  retained route after this change.

1. Open `/analytics` from the sidebar and by direct URL.
2. Verify the active Brand Profile changes the data; "All Brand Profiles" is the
   aggregate.
3. Switch each range, platform, and metric; verify the URL, chart, KPIs, and
   Post ranking update and survive back/forward.
4. Verify a Post with several supported Distributions sums them; a Post whose
   Provider lacks analytics access shows `Not supported`, not zero.
5. Verify partial, awaiting-sync, no-capable-channel, no-published-Post, loading,
   and error states.
6. Verify light and dark themes, keyboard navigation, focus visibility, the
   hidden chart table, and manual/OS reduced motion.
7. Verify the Posts and Channels routes do not download Recharts or the analytics
   chart chunk.

## 11. Acceptance criteria

- The sidebar shows Posts, Analytics, Channels; `/analytics` is a lazy, standalone
  page.
- Summary data uses `published_at`, and the page labels the cohort semantics.
- `GET /api/v1/analytics/posts` exists, is documented, generated, and tested.
- The page shows only views, likes, comments, shares, and published destinations;
  unsupported metrics and unsynced destinations never appear as zero.
- `partial` and `unsupported_platforms` describe only published channels in
  scope.
- The EvilCharts bar chart uses the Recharts engine, CSS tokens, reduced-motion
  behavior, and an accessible tabular alternative.
- URL state, refresh behavior, empty/error/loading states, and responsive layout
  match this specification.
- Documentation no longer claims analytics is absent.
- All verification commands above pass.

## 12. Risks and rollback

- EvilCharts is vendored source, not a versioned package. Pin Recharts `3.8.0`,
  keep the generated files isolated, and review registry updates as code.
- Every supported Provider reports analytics when its analytics scope is granted;
  Threads engagement may still be disabled by deployment acceptance flags, and
  older connections need reauthorization. The empty states must make this explicit
  rather than showing an empty dashboard.
- Cohorts can be mistaken for activity in the range. The range and KPI captions
  are mandatory, not optional copy.
- The summary semantic fix changes existing API behavior. No current frontend
  consumer depends on the old `event_at` or always-true `partial` behavior, but
  update the worker tests and contract readiness evidence.
- The new indexes add write cost. They are additive and can be dropped in a
  follow-up migration if query plans show they are unnecessary.
- Rollback: remove the nav entry and route, stop calling the new endpoint, and
  revert the additive contract fields. Analytics snapshots and existing endpoints
  remain intact; no data migration is required.
