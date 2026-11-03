# Improvement reporting operations

Meltiply can send two independent, off-by-default categories of improvement
reporting to the maintainer's PostHog Cloud project: aggregate **usage
statistics** and scrubbed **diagnostics**. Both are optional; neither affects
installation, sign-in, publishing, or scheduled work when it is off, unconfigured,
or unavailable. This page is the operational contract: what is collected, how it
leaves an installation, what to configure, and how to read the receiving project.

The [privacy policy](../frontend/public/content/docs/privacy.mdx) and
[cookies](../frontend/public/content/docs/cookies.mdx) pages describe the same
behavior for end users. An Installation Owner controls the choices; the
implementation lives in `packages/reporting` and the HTTP contract is
`GET`/`PUT /api/v1/installation/reporting`.

## What is collected

Server-side collection only. There is no autocapture, session replay, pageview
tracking, heatmap, advertising attribution, or cross-site identifier, and no
browser SDK is loaded for this feature.

| Category    | Sent when                                                                           | Contents                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage       | Once per day after the Owner enables it and a destination is configured             | Daily aggregate counters (below) for that UTC day.                                                                                              |
| Diagnostics | When an unexpected application failure occurs after the Owner enables it            | One sanitized exception: fixed category, operation group, optional Platform, app version, and allowlisted application stack frames.             |
| Discovery   | Only when the Owner presses **Share feedback** on the one-time attribution question | The chosen fixed discovery-source value, app version, and deployment category. Never on skip, **Prefer not to say**, or later settings changes. |

Names, email addresses, Workspace names, Brand Profile names, Channel identities,
Post text, Asset URLs, audience comments, credentials, cookies, request or
response bodies, and database values never enter a report. Outbound payloads are
validated against a property allowlist after sanitization, so an unlisted key fails
the send rather than leaking.

### Usage report fields

Event `meltiply_usage_daily`, one per installation per reporting interval per UTC
day, with `distinct_id` equal to the installation's random reporting identifier.

| Property                     | Meaning                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`             | Payload schema version, currently `1`.                                                                                                         |
| `report_date`                | UTC day the counters cover, `YYYY-MM-DD`.                                                                                                      |
| `app_version`                | Bounded application version string.                                                                                                            |
| `deployment_category`        | `managed`, `selfhosted`, or `unknown`.                                                                                                         |
| `channels`                   | Connected Channels per Platform at report time, keyed by Platform.                                                                             |
| `publications.posts`         | Confirmed successful Posts in this UTC day. A Post counts once, on its first Distribution confirmed published.                                  |
| `publications.distributions` | Confirmed successful Distributions per Platform in this UTC day.                                                                               |
| `engagement`                 | Per Platform `{views, reactions, comments, shares, distributions, as_of}` from the latest eligible stored Provider snapshot per Distribution.   |
| `engagement_as_of`           | Newest snapshot capture time across every per-Platform gauge.                                                                                   |
| `engagement_coverage`        | `{measured, missing, truncated, unsupported_metrics}` Distribution counts and metric omissions, so partial or bounded coverage is visible.      |

Only closed UTC days are reported: the immediate previous day always, and up to
six earlier days when they carry confirmed publications. An open day is never
sent, and a repeated invocation or a partial delivery reuses the same frozen
report identity rather than producing a second measurement.

A confirmed publication belongs to the day its measurement committed, read from
the database clock under the same lock the daily producer takes before it derives
a day. A transaction that began before midnight and committed after it therefore
counts in the day it truly committed, and the producer waits for an in-flight
measurement instead of freezing a day without it. No confirmed success is ever
discarded because a day was already reported.

Rules that matter when reading the numbers:

- Missing or unsupported metrics are **omitted**, never reported as `0`, and named
  in `engagement_coverage.unsupported_metrics`. That includes a Platform whose
  adapter normalizes an absent insight to zero: an all-zero snapshot there is
  unknown, not an observed zero.
- `engagement.<platform>.as_of` is that Platform's newest contributing snapshot;
  `engagement_as_of` is the newest of them. Compare a gauge against its own
  Platform timestamp, not the report time.
- `engagement_coverage.truncated` means the cohort read reached its bound before
  covering every eligible Distribution. `missing` counts eligible Distributions
  with no stored snapshot. Neither is zero-filled.
- `engagement` values are **as-of gauges** taken from stored Provider snapshots.
  They are not daily audience actions, and they must not be summed across days:
  a lifetime view count repeated on consecutive days is the same views, not new
  views. A downward Provider correction lowers the gauge; it is never accumulated.
- Publication counters count confirmed successes during enabled reporting
  intervals only. Queued work, Provider attempts, automatic retries, Ambiguous
  outcomes, and success from before an interval never count.
- `channels` counts the canonical connected state: a stored `connected` or
  `expiring` Channel that is not revoked, whose token is not past its expiry, on
  an active Brand Profile. Expired and revoked Channels are absent.
- Counters are durable local measurements. Deleting a Post, Distribution, or
  Channel afterwards does not reduce an already-reported success.
- A Post's successful Distributions may span Platforms, so summing per-Platform
  distinct-Post counts is not a valid global distinct count. Only
  `publications.posts` is a Post total.

### Diagnostic reports

Event `$exception` in PostHog Error Tracking, shaped like the documented SDK
serialization: `$exception_list` with `type`, `value`, `mechanism` and
`stacktrace.frames`, plus `$exception_level: "error"`. `value` is the fixed
failure category rather than the runtime message, so grouping keys on the
sanitized type and application frame locations. Rejected or truncated frames are
dropped instead of guessed. Expected, recoverable Provider conditions use the
`provider_failure` category with a fixed `provider_failure_class` (`auth`,
`quota`, `rate_limit`, `timeout`, `transient`, `deterministic`, `ambiguous`) and
are marked handled, so they stay out of unexpected-exception tracking; no Provider
message, status code, or response body is ever sent.

### Discovery-source feedback

Event `meltiply_feedback_discovery_source`, with its own random `distinct_id`
(the feedback response identity) rather than the installation reporting
identifier, so the attribution answer is not linked to the installation's usage
series. It carries only `discovery_source`, `app_version`, `deployment_category`
and `schema_version`.

## Consent, identity, and transport

- Both categories start **off**, including for installations that upgrade to a
  release with this feature. There is no enrollment by default, and opening the
  setup screen or ignoring it is not consent.
- Choices are persisted before any report is sent, and the effective policy is
  re-read immediately before every send and retry. A withdrawal, an operator
  override, a missing destination, or unreadable preference state stops
  transmission, and withdrawal also discards that category's unsent reports.
- The installation reporting identifier is generated randomly on first opt-in. It
  is never derived from a name, email, domain, machine fingerprint, or account
  identity.
- Capture sets `$process_person_profile: false` and sends no `$set`, so no
  person profile is created or enriched. Reports linked to one installation over
  time are **pseudonymous**, not anonymous. Never describe them as fully
  anonymous.
- Capture also sets `$geoip_disable: true`. This disables vendor GeoIP
  enrichment only; it does not hide the sender's address from HTTPS ingress. A
  maintained project must additionally discard client IP data and keep IP
  collection off, because the ingress, the maintainer's Cloudflare account, and
  any operator log can still observe the source of a request.
- Delivery is bounded and best effort: one event per request, a 3-second
  timeout, no redirects, a bounded pending queue, exponential backoff, and a
  maximum 7-day lifetime for unsent reports. Transport failures are values, never
  exceptions: a PostHog outage cannot change an HTTP status, a queue
  acknowledgement, or a scheduled invocation's outcome, and the transport never
  reports its own failure back to PostHog.
- Retries reuse a frozen `uuid` and `timestamp` per logical report. PostHog
  de-duplicates events that share `uuid`, `event`, `timestamp` and `distinct_id`,
  but only **eventually**, during background merges — it is not an immediate
  guarantee — so dashboards must also group on the logical report rather than
  summing raw deliveries.

## Deployment configuration

| Binding                           | Meaning                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `REPORTING_POSTHOG_PROJECT_TOKEN` | Publishable project token (`phc_…`). Absent or malformed means reporting is unavailable.                     |
| `REPORTING_POSTHOG_HOST`          | Matching ingestion origin, e.g. `https://us.i.posthog.com` or `https://eu.i.posthog.com`. Must be an origin. |
| `REPORTING_FORCED_OFF`            | `true` disables both categories over any saved choice. Anything else leaves the Owner's choice in effect.    |
| `DEPLOYMENT_CATEGORY`             | `managed` or `selfhosted`; any other value reports `unknown`.                                                |

Missing configuration is not a deployment failure. Readiness does not require
these bindings, and an unconfigured installation simply reports
`destination_configured: false` with both categories unusable. Never invent a
token, a default destination, or a project that has not been provisioned.

The ingestion token is publishable rather than secret: it authorizes event
ingestion for that project and grants no project or organization administration.
Do not substitute a personal API key. Keep the token out of browser bundles,
support tickets, and logs, and treat any project-wide setting behind it as
maintainer-only.

### Managed (Cloudflare) deployment

The reviewed release input carries the optional destination, so a release without
one deploys normally:

```json
{
  "runtime": {
    "reporting_posthog_project_token": "phc_…",
    "reporting_posthog_host": "https://us.i.posthog.com",
    "reporting_forced_off": false
  }
}
```

Set both destination fields or neither; the release rejects a half-configured
destination. The rendered API and Automation configurations always declare
`DEPLOYMENT_CATEGORY=managed` and `REPORTING_FORCED_OFF`. See the
[managed deployment guide](../infra/cloudflare/README.md).

### Self-hosted (Compose) deployment

The released `meltiply-runtime` image is built with the maintainer's publishable
token and matching origin, so an operator needs no PostHog account. The runtime
uses an image default only when `.env.selfhost` leaves the binding empty; an
explicit value overrides it, and an empty value with no image default keeps
reporting off. `DEPLOYMENT_CATEGORY` is always `selfhosted` for this target.

```dotenv
# Optional overrides; leave commented to use the image's maintainer destination.
# REPORTING_POSTHOG_PROJECT_TOKEN=phc_…
# REPORTING_POSTHOG_HOST=https://us.i.posthog.com
# Set to true to disable improvement reporting across the whole installation.
REPORTING_FORCED_OFF=false
```

See [self-hosting](self-hosting.md) for the rest of the deployment.

### Release prerequisite

No maintainer PostHog project token or region exists in this repository, and a
release that offers working improvement reporting must have both. Until the
maintainer provisions a project and supplies the token and matching origin
through the release input (`runtime.reporting_posthog_project_token` and
`runtime.reporting_posthog_host`) and, for released self-hosted images, the
`REPORTING_POSTHOG_PROJECT_TOKEN` and `REPORTING_POSTHOG_HOST` repository
variables the image workflow passes as build arguments, released artifacts ship
**no destination**: the settings screen honestly reports reporting as
unavailable, and no improvement data is transmitted. Creating the project is a
release prerequisite, not something an installation can satisfy locally.

## Receiving project setup

The maintainer project must be configured before it can be trusted:

- **Disable autocapture, automatic pageviews, session replay, and heatmaps.** The
  integration never sends them; leaving them enabled only means an accidental
  browser integration would start collecting.
- **Discard client IP data** and do not enable GeoIP enrichment or other
  IP-derived properties. Discarding at the project level still permits
  transformations to use the address first, so also confirm no such transformation
  is enabled.
- **Keep person profiles off** for these events. Do not identify these
  `distinct_id` values or link them to member accounts.
- **Review collection-layer logging.** Data-pipeline transformations, batch
  exports, and any proxy or collector the maintainer adds can log request bodies
  and source addresses; the application cannot make that safe.
- **Set billing limits** per product and keep the 80%/100% alerts enabled.

## Dashboards

Build these as insights over `meltiply_usage_daily`, `$exception`, and
`meltiply_feedback_discovery_source`. Every chart is labelled as coming from
**participating installations**; opt-in data is not a census of Meltiply usage,
and a change in a chart may be a change in who opted in rather than in usage.

Delivered rows are not measurements. Transport retries repeat one frozen identity,
and vendor de-duplication is eventual, so every usage chart reduces in two
independent steps:

1. **Deduplicate deliveries by frozen event identity** — one row per
   `properties.$insert_id` (equivalently `uuid` + `event` + `timestamp` +
   `distinct_id`). This removes retry copies and nothing else.
2. **Then group by the measurement's own logical key** —
   `distinct_id` + `properties.consent_interval_started_at` + `report_date` +
   `schema_version` — and count each group **once**.

The consent interval is part of that key on purpose. Withdrawing and re-enabling
reporting inside one UTC day legitimately produces two reports for the same day,
each counting activity from its own interval. A key without the interval would
treat them as duplicates and silently drop one interval's publishing.

Counters and gauges then reduce differently:

- **Counters** (`publications.posts`, `publications.distributions.*`) are summed
  **across intervals** after step 2, because each interval counted its own
  successes.
- **Gauges** (`channels`, `engagement.*`, `engagement_coverage`) are not summed.
  Take the newest report per installation (highest `timestamp`, then highest
  `uuid`) and read its values, because a repeated lifetime figure is the same
  figure, not an addition.
- Never `SUM` raw delivered rows, and never `SUM` a gauge across days.

### Adoption

- **Connected Channels by Platform** — latest report per installation, then sum
  `properties.channels.<platform>`. Labelled "connected Channels, participating
  installations".
- **Participating installations** — count distinct `distinct_id` in
  `meltiply_usage_daily` for the selected window, optionally split by
  `deployment_category` and `app_version`.
- **Platform mix** — share of participating installations with at least one
  Channel on each Platform, from the same latest-report snapshot.

### Publishing volume

- **Successful Posts** — after de-duplicating deliveries by `uuid`, sum
  `properties.publications.posts` per installation, reporting interval, and
  `report_date`. Label it "Posts (confirmed successes)".
- **Successful Distributions by Platform** — same reduction, then sum
  `properties.publications.distributions.<platform>`. Label it "Distributions".
- **Posts vs Distributions** — one chart with both series, so a Post published to
  several Platforms is visibly one Post and several Distributions.
- Do not add per-Platform distinct-Post counts together, and do not compare these
  counters with Provider-side totals: queued, retried, and Ambiguous work is
  deliberately excluded.

### Engagement as-of gauges

- **Views / reactions / comments / shares by Platform** — take the latest report
  per installation, then sum each `properties.engagement.<platform>.<metric>`.
  Never `SUM` across `report_date`.
- **Coverage** — sum `properties.engagement_coverage.measured` and
  `.missing` from the same latest reports; show the ratio next to each gauge, and
  flag a report whose `.truncated` is true instead of treating its gauges as
  complete. Read `.unsupported_metrics` as the reason a metric is absent.
- **Freshness** — use each `properties.engagement.<platform>.as_of`, falling back
  to `engagement_as_of`; a stale timestamp means the snapshot is old, not that
  engagement stopped. One Platform can be hours newer than another.
- Treat an absent metric key as unknown. A displayed zero must come from an
  observed zero, so break down by `platform` before concluding a Platform reports
  nothing.
- **Publication counters** are period counters, so reduce duplicate deliveries by
  PostHog `uuid` and then by the installation's reporting interval and
  `report_date`; a re-enabled interval has its own counter series and must not be
  merged with the withdrawn one.

### Expected failures and diagnostics

- **Unexpected exceptions by release and operation** — Error Tracking issues
  grouped by `app_version` and `operation_category`, filtered to
  `$exception_level: error`.
- **Failures by category and Platform** — `diagnostic_category` × `platform`
  counts, excluding handled Provider conditions from the "unexpected" view.
- **Diagnostics volume per installation** — distinct reporting identifiers per
  day, to spot a repeat-failure loop; ingest is bounded per hour, so a flat
  ceiling is expected behavior rather than data loss to chase.
- Expected, categorized Provider conditions (expired authorization, rate limits)
  are normal operation and should not be triaged as application bugs.

### Discovery sources

Count `meltiply_feedback_discovery_source` events per `discovery_source`. Each
installation submits at most one, and skip or **Prefer not to say** produces no
event at all, so the denominator is "installations that chose to share", never
"installations surveyed".

## Consent metadata

Each category stores the disclosure version its decision was recorded against,
alongside the decision time and the interval it enabled. Reporting fails closed
when a requested category's stored version is missing or no longer the
supported one, so a decision cannot authorize a payload its disclosure never
described. Re-saving an unchanged choice leaves that metadata alone rather than
silently upgrading it; only an actual change records a new decision.

## Costs, retention, and deletion

- Volume is deliberately small: at most one usage event per installation per
  UTC day, at most one attribution event ever, and diagnostics bounded per
  installation and hour. There is no per-view, per-click, or per-Provider-attempt
  event.
- PostHog Cloud applies the plan's event retention: currently one year on the
  free plan and seven years on paid plans, and organization admins can shorten
  the window, with older events removed at the next monthly cleanup rather than
  immediately. Confirm the configured plan and any project-level window; do not
  assume a retention period.
- Per-product billing limits stop ingestion once the dollar cap is reached, and
  data above the cap is discarded permanently, so a cap can silently truncate
  reporting. Alerts fire at 80% and 100% of the limit and of the free allotment.
  Review each product's limits rather than assuming one cap covers the project.
- Local retention is bounded on the bytes, not just the row state: a report that
  was sent or discarded has its payload deleted once it is off any retry path,
  leaving only a minimal receipt that keeps the logical identity from being
  replayed. Unsent optional data expires after at most seven days.
- Withdrawal stops future sending and discards unsent local reports, including a
  batch already claimed for delivery: a row is only transmitted while its own
  consent interval is still the live one. It does not
  delete data already received. Deleting a PostHog person does not remove
  no-profile events, so deletion of received installation-scoped data must use a
  vendor-supported procedure — a project deletion removes all of its data, while
  a narrower request needs vendor support or a verified event-deletion workflow.
  Do not promise a deletion outcome the configured plan does not provide.

## Synthetic ingestion check

A successful HTTP response proves only that the endpoint accepted a request. Once
the maintainer project exists, verify ingestion against the project itself with
synthetic data only — never a real member's installation:

1. Configure a disposable installation (or a test deployment) with the destination
   under test and enable diagnostics.
2. Trigger one unexpected failure through a route that does not carry member data,
   for example a deliberately broken test endpoint.
3. Inspect the project: confirm one `$exception` event arrived with the expected
   `schema_version`, `app_version`, `deployment_category`,
   `diagnostic_category`, and that `$exception_list` contains sanitized frames.
4. Confirm the event has no person profile, no `$geoip` properties, no URL with a
   query string, and none of the canary values used in the test.
5. For usage, run the daily scheduled unit against a seeded installation, then
   confirm the `meltiply_usage_daily` event properties match the seeded
   measurements and that the dashboard shows the same numbers after the
   deduplicated reduction.
6. Delete the synthetic events with the vendor's supported deletion procedure and
   record the outcome.

This check requires the maintainer project and cannot run in CI. A real live
project inspection has **not** been performed for this repository; it remains a
release prerequisite alongside provisioning the token and origin.

## Verification

Deterministic coverage uses real Worker entrypoints against real PostgreSQL with a
controlled loopback receiver, so privacy and counting regressions are caught
without production credentials: the reporting policy over HTTP, payload
allowlisting, consent withdrawal, duplicate and retry identity, and the scheduled
delivery path. The hosted `cloudflare-full` lane additionally runs the real-stack
browser journey for first-run setup and opt-in reporting against that controlled
receiver, and the self-hosted image lane exercises the production Compose stack.
