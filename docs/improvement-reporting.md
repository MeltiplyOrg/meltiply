# Improvement reporting operations

Usage and diagnostics are independent, off-by-default reports to the maintainer's
PostHog project. The Installation Owner controls consent; members can read the
effective policy. Missing configuration or a destination outage never disables
the product. End-user disclosures live in the
[privacy](../frontend/public/content/docs/privacy.mdx) and
[cookies](../frontend/public/content/docs/cookies.mdx) guides.

## What is collected

Server-side collection only. There is no autocapture, session replay, pageview
tracking, heatmap, advertising attribution, or cross-site identifier, and no
browser SDK is loaded for this feature.

| Category    | Sent when                                                                           | Contents                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage       | After opt-in, per reporting interval and closed UTC day                             | Aggregate counters and as-of gauges described below.                                                                                            |
| Diagnostics | After opt-in, on an application failure or categorized Provider condition           | Fixed category, operation group, optional Platform, app version and sanitized application frames.                                               |
| Discovery   | Only when the Owner presses **Share feedback** on the one-time attribution question | The chosen fixed discovery-source value, app version, and deployment category. Never on skip, **Prefer not to say**, or later settings changes. |

Names, email addresses, Workspace names, Brand Profile names, Channel identities,
Post text, Asset URLs, audience comments, credentials, cookies, request or
response bodies, and database values never enter a report. Outbound payloads are
validated against a property allowlist after sanitization, so an unlisted key fails
the send rather than leaking.

### Usage report fields

Event `meltiply_usage_daily`, one per installation per reporting interval per UTC
day, with `distinct_id` equal to the installation's random reporting identifier.

| Property                     | Meaning                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`             | Payload schema version, currently `1`.                                                                                                        |
| `report_date`                | UTC day the counters cover, `YYYY-MM-DD`.                                                                                                     |
| `app_version`                | Bounded application version string.                                                                                                           |
| `deployment_category`        | `managed`, `selfhosted`, or `unknown`.                                                                                                        |
| `channels`                   | Connected Channels per Platform at report time, keyed by Platform.                                                                            |
| `publications.posts`         | Confirmed successful Posts in this UTC day. A Post counts once, on its first Distribution confirmed published.                                |
| `publications.distributions` | Confirmed successful Distributions per Platform in this UTC day.                                                                              |
| `engagement`                 | Per Platform `{views, reactions, comments, shares, distributions, as_of}` from the latest eligible stored Provider snapshot per Distribution. |
| `engagement_as_of`           | Newest snapshot capture time across every per-Platform gauge.                                                                                 |
| `engagement_coverage`        | `{measured, missing, truncated, unsupported_metrics}` Distribution counts and metric omissions, so partial or bounded coverage is visible.    |

Only closed UTC days are reported: the immediate previous day always, and up to
six earlier days when they carry confirmed publications. An open day is never
sent, and a repeated invocation or a partial delivery reuses the same frozen
report identity rather than producing a second measurement.

Publication counts use the database clock under the measurement/producer lock.
The producer waits for in-flight measurements, so a transaction crossing midnight
counts on its actual commit day instead of being lost from a frozen report.

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

- Both categories start **off**, including on upgrade. Visiting or skipping setup
  never records consent.
- Consent is persisted before enqueueing and rechecked before every send/retry.
  Withdrawal discards unsent reports; operator override, missing destination or
  unreadable preferences also prevent transmission.
- Decisions retain their disclosure version and enabled interval. Missing or
  unsupported versions fail closed; re-saving an unchanged choice never upgrades
  the recorded disclosure.
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
- Delivery uses a bounded durable queue, exponential backoff and a maximum
  seven-day retry lifetime. Failures never change product outcomes or report
  themselves. Automation diagnostics enqueue only; scheduled delivery owns HTTP.
- Retries reuse frozen event identities. Vendor de-duplication is eventual, so
  dashboards must also reduce logical measurements as described below.

## Deployment configuration

| Binding                           | Meaning                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `REPORTING_POSTHOG_PROJECT_TOKEN` | Publishable project token (`phc_…`). Absent or malformed means reporting is unavailable.                     |
| `REPORTING_POSTHOG_HOST`          | Matching ingestion origin, e.g. `https://us.i.posthog.com` or `https://eu.i.posthog.com`. Must be an origin. |
| `REPORTING_FORCED_OFF`            | `true` disables both categories over any saved choice. Anything else leaves the Owner's choice in effect.    |
| `DEPLOYMENT_CATEGORY`             | `managed` or `selfhosted`; any other value reports `unknown`.                                                |

Both destination bindings are optional; absent or malformed values keep reporting
unavailable without failing deployment. Use a publishable project token, never a
personal API key. Keep it out of browser bundles and logs.

The [managed deployment guide](../infra/cloudflare/README.md) owns release-input
configuration. [Self-hosting](self-hosting.md) owns image defaults and operator
overrides: released images can carry the maintainer destination, so operators
need no PostHog account. Explicit environment values override image defaults;
without either, nothing is sent.

Before offering working reporting, provision the maintainer project, supply its
token and matching regional origin to release inputs and self-hosted image build
variables, and perform the live-project check below. Never invent credentials or
claim an unconfigured destination works.

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

Label every dashboard **participating installations**: opt-in data is not a census,
and a trend can reflect changing participation rather than changing usage.

Usage reductions have two independent keys:

1. Deduplicate retries by `properties.$insert_id` (equivalently
   `uuid` + `event` + `timestamp` + `distinct_id`).
2. Deduplicate measurements by `distinct_id` +
   `properties.consent_interval_started_at` + `report_date` + `schema_version`.

Re-enabling within a UTC day creates another legitimate interval. Sum publication
counters across those intervals, but never merge their keys or sum raw deliveries.
Gauges (`channels`, `engagement`, `engagement_coverage`) use the newest report per
installation, ordered by `timestamp` then `uuid`; never sum them across days.

### Adoption

- **Connected Channels by Platform** — sum `channels.<platform>` from each
  installation's latest report.
- **Participating installations** — distinct `distinct_id` for the selected window,
  split by deployment category or app version when useful.
- **Platform mix** — installations with a connected Channel per Platform.

### Publishing volume

- **Posts (confirmed successes)** and **Distributions by Platform** — reduce
  deliveries/measurements first, then sum `publications.posts` and
  `publications.distributions.<platform>` by `report_date`.
- Show Posts and Distributions together: publishing one Post to several Platforms
  is one Post and several Distributions. Never sum per-Platform distinct-Post counts.
- These counters exclude queued, retried and Ambiguous work; Provider-side totals
  are not comparable.

### Engagement as-of gauges

- **Views / reactions / comments / shares by Platform** — sum each metric from
  installations' latest reports, not across reporting days.
- **Coverage** — show `measured` / (`measured` + `missing`) alongside gauges.
  Flag `truncated` reports and explain omissions with `unsupported_metrics`.
- **Freshness** — use the Platform's `as_of`, falling back to `engagement_as_of`.
  An absent metric is unknown, not zero; Platform snapshots can have different ages.

### Expected failures and diagnostics

- **Unexpected exceptions by release/operation** — Error Tracking issues grouped
  by `app_version` and `operation_category`, filtered to `$exception_level: error`
  and `diagnostic_handled: false`, excluding `diagnostic_category: provider_failure`.
- **Failures by category/Platform** — `diagnostic_category` × `platform`; keep
  handled Provider conditions out of unexpected-defect counts.
- **Diagnostics volume per installation/day** — identify repeat-failure loops;
  the hourly ingestion bound can produce a flat ceiling.

### Discovery sources

Count `meltiply_feedback_discovery_source` events per `discovery_source`. Each
installation submits at most one, and skip or **Prefer not to say** produces no
event at all, so the denominator is "installations that chose to share", never
"installations surveyed".

## Costs, retention, and deletion

- Usage has one logical event per installation/consent interval/closed UTC day;
  discovery has at most one shared answer ever. Diagnostics are hourly bounded,
  not per view, click or Provider attempt.
- Configure and verify receiving-project retention and per-product billing caps.
  Retention cleanup need not be immediate, and caps discard excess events rather
  than delaying them. Enable billing alerts and treat truncated ingestion honestly.
- Unsent local data expires within seven days. Sent/discarded payloads are pruned,
  leaving minimal receipts to prevent replay.
- Withdrawal stops future transmission, including previously claimed batches,
  but cannot retract received events. Deleting a person does not delete no-profile
  events. Installation-scoped deletion needs a verified vendor-supported workflow
  or vendor support; project deletion removes the entire project's data. Never
  promise deletion the configured plan cannot provide.

## Synthetic ingestion check

An HTTP success or controlled receiver is not live-ingestion proof. With a
disposable installation and synthetic data only:

1. Enable diagnostics and trigger a data-free unexpected failure. Inspect the
   project's `$exception` and sanitized frames, release, deployment and category.
2. Verify no person profile, GeoIP properties, query-string URLs or canary values.
3. Run daily usage against seeded measurements; compare the received properties
   and deduplicated dashboard totals with the seed.
4. Delete the synthetic events using the supported procedure and verify deletion.

This requires maintainer project access; CI's controlled receiver cannot replace it.
