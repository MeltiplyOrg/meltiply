# MVP release acceptance

Use this checklist to decide whether an exact release candidate can serve persistent
live users under [STATE.md](../STATE.md). Checked items apply only to the candidate
identified in the evidence below; they do not establish live acceptance. The
[capability inventory](frontend-capabilities.md) defines the shipped scope; this
checklist does not add features.

## Scope, evidence, and safety

- [ ] Record the candidate Git SHA, contract version, deployment target and origin,
      previous deployed revision, tester, and supported Providers, publishing methods,
      storage backend, and architectures in a protected release record.
- [ ] Use a production-built candidate, controlled accounts and recipients, and a
      dedicated test installation. Label test publications and agree how to remove
      them. Run fault injection, concurrent requests, destructive operations, and
      restore drills only against isolated fixtures or disposable clones.
- [ ] For every applicable item, record steps and inputs, expected and observed
      results, and redacted evidence: hosted run/artifact links, screenshots, request
      IDs, Post/Distribution IDs, or Provider references. Keep credentials, signed
      URLs, encoder keys, private content, and raw database dumps out of shared evidence.
- [ ] Record exclusions with a reason and owner. An unavailable Provider, architecture,
      or storage backend may be outside the advertised release scope; a reachable
      advertised workflow cannot be excluded merely because it fails or is untested.
- [ ] Repeat affected checks after candidate changes. Reuse earlier evidence only
      with a recorded explanation that the relevant code, configuration, dependencies,
      and environment are unchanged. Treat skips, timeouts, blocked credentials, and
      unexplained flaky retries as unresolved, not passes.

## Hosted automated gates

Use GitHub-hosted runners and the [CI guide](public-ci.md); serialize manually started
resource-intensive runs. Do not change CI scheduling or cancel runs without approval.
These checks supplement live acceptance; controlled Provider responses do not prove
real credentials, app review, external mail delivery, or actual publication.

- [x] The candidate's `ci-gate` passes with every applicable application and image lane
      selected. A docs-only routed pass is not an application release gate.
- [x] The full application gate passes on the candidate (`cloudflare-full`, or an
      applicable extended lane that includes `bun run cloudflare:check`).
- [ ] `frontend-full` and `frontend-ui` pass for browser journeys and actual-surface
      coverage described in [frontend verification](frontend-verification.md).
- [ ] `publishing-flow`, `publishing-browser`, and `publishing-queues` pass for durable
      publication, browser behavior, and weekly allocation.
- [ ] `device-authorization`, `object-storage`, and the applicable portable-caching
      lanes pass for the exposed device, storage, and self-hosted paths.
- [ ] Applicable performance lanes pass; inspect traces and reports, not only job
      status. Explain retried passes before accepting them as release evidence.
- [ ] `versioned-contract` passes. For managed releases, `managed-release` also passes;
      for image releases, both native architecture build/smoke jobs pass for the exact
      artifacts being published. These results do not replace the target drills below.

### Candidate evidence

Candidate: `c54cd7e17356a02695ffc91c67d574351a8e5d37`; application and contract package
version: `1.0.0-target.0`. Tester: coding assistant, hosted dispatch account `tmih06`.
All runs used this SHA and disposable GitHub-hosted fixtures; manually started runs
were serialized. No deployed resources, Provider acceptance flags, or project state
were changed. The documentation-only evidence commit does not retest or change the
candidate's application, configuration, or dependencies.

The full manual CI selected every application and image lane, including six native
image builds and production Compose smoke on amd64 and arm64. Controlled Provider
responses, production-built browser assets, PostgreSQL, workerd, MinIO, and native
processing establish fixture coverage, not real Provider or target acceptance.
Deployment origin, previous deployed revision, accepted Provider/method scope, and
operator recovery objectives remain unrecorded. Live checks below remain unchecked.

| Gate or lane               | Result | Run evidence                                                                    |
| -------------------------- | ------ | ------------------------------------------------------------------------------- |
| Full manual CI / `ci-gate` | Pass   | [42009425662](https://github.com/MeltiplyOrg/meltiply/actions/runs/42009425662) |
| `cloudflare-full`          | Pass   | [42010561644](https://github.com/MeltiplyOrg/meltiply/actions/runs/42010561644) |
| `managed-release`          | Pass   | [42012073239](https://github.com/MeltiplyOrg/meltiply/actions/runs/42012073239) |
| `frontend-full`            | Fail   | [42013264330](https://github.com/MeltiplyOrg/meltiply/actions/runs/42013264330) |
| `frontend-ui`              | Pass   | [42015217432](https://github.com/MeltiplyOrg/meltiply/actions/runs/42015217432) |
| `publishing-flow`          | Fail   | [42016300340](https://github.com/MeltiplyOrg/meltiply/actions/runs/42016300340) |
| `publishing-browser`       | Fail   | [42021078340](https://github.com/MeltiplyOrg/meltiply/actions/runs/42021078340) |
| `publishing-queues`        | Pass   | [42024652576](https://github.com/MeltiplyOrg/meltiply/actions/runs/42024652576) |
| `device-authorization`     | Pass   | [42026351590](https://github.com/MeltiplyOrg/meltiply/actions/runs/42026351590) |
| `object-storage`           | Pass   | [42027583783](https://github.com/MeltiplyOrg/meltiply/actions/runs/42027583783) |
| `portable-caching`         | Fail   | [42033033322](https://github.com/MeltiplyOrg/meltiply/actions/runs/42033033322) |
| `portable-caching-smoke`   | Pass   | [42034457304](https://github.com/MeltiplyOrg/meltiply/actions/runs/42034457304) |
| `performance-focused`      | Pass   | [42035422726](https://github.com/MeltiplyOrg/meltiply/actions/runs/42035422726) |
| `performance-backend`      | Pass   | [42035697507](https://github.com/MeltiplyOrg/meltiply/actions/runs/42035697507) |
| `performance-media`        | Pass   | [42060197945](https://github.com/MeltiplyOrg/meltiply/actions/runs/42060197945) |
| `cloudflare-extended`      | Pass   | [42060890541](https://github.com/MeltiplyOrg/meltiply/actions/runs/42060890541) |
| `versioned-contract`       | Fail   | [42060996494](https://github.com/MeltiplyOrg/meltiply/actions/runs/42060996494) |
| `cloudflare-integration`   | Pass   | [42062066743](https://github.com/MeltiplyOrg/meltiply/actions/runs/42062066743) |

The remaining grouped gates are incomplete:

- `frontend-full`: 52 browser passes, two failures, two flaky passes, and three
  skips. Reporting expects queued feedback without a configured destination;
  completed-setup sign-in hits authentication throttling. Sign-out and the MOV
  journey pass only on retry; the latter initially reaches the workspace error
  boundary. Their causes remain unresolved. The dedicated controlled-reporting
  configuration passes all four onboarding journeys in `cloudflare-full`.
  Later recovery and Lighthouse commands in `frontend-full` are not reached.
- Both publishing lanes: the all-Platform video journey times out waiting for a
  Facebook Reel Visibility control absent from the captured UI; multi-profile
  recovery stops because its textbox locator matches three controls. Five other
  publication journeys and the Queue journey pass, but these blocked paths are
  not accepted.
- `portable-caching`: sign-in succeeds, then token issuance returns HTTP 500 with
  Better Auth's private-key decryption error. A persisted-fixture/secret mismatch
  is suspected, not proven. The fresh-fixture smoke pass does not clear this failure.
- `versioned-contract`: release tests pass, but artifact production rejects stale
  release metadata. The subsequent production-entry health smoke is not reached.
- CI's four browser performance journeys pass with retries disabled, but the later
  preferences journey overwrites their measurements before artifact upload.
  Retained journey JSON/traces cannot be reviewed, so performance acceptance remains
  incomplete despite passing lane statuses.

Independent runtime proof includes live OpenAPI/CORS/webhook smoke, 212 native
processor assertions with restart/replay, and bounded Queue fanout/redelivery.
The public-endpoint load probe covers only three virtual users over 20 seconds:
693 requests with no failures. It does not establish representative authenticated
composition, upload, delivery, analytics capacity, or production cost.

Commands: `gh workflow run ci.yml --ref feature/first-release-stabilization` and
`gh workflow run extended.yml --ref feature/first-release-stabilization -f lane=LANE`.
Run steps retain the exact inputs and assertions. Preserve redacted evidence before
the extended artifacts expire on November 12; raw browser artifacts can contain
fixture passwords, session headers, private content, and signed capabilities.
This evidence is not the protected release record or a release-owner sign-off.

## Installation, onboarding, and authentication

- [ ] Install from the documented managed or self-hosted production path without
      development servers, seeded identities, fixture endpoints, or test credentials.
      Health identifies the selected revision/contract; readiness detects unavailable
      required dependencies without exposing secrets.
- [ ] On a fresh installation, missing/wrong setup secrets cannot create an Owner.
      The authorized first signup creates exactly one Owner and Workspace; concurrent
      bootstrap attempts cannot create a second Owner. Registration then stays closed
      through both UI and direct API calls.
- [ ] Interrupt and resume Owner setup. The Workspace name and optional-screen progress
      persist; skipping reporting keeps it off. Invited members and existing installations
      are not forced into first-run setup.
- [ ] Verify sign-in, invalid credentials, sign-out, expired sessions, and protected-route
      redirects. A revoked session's JWT no longer authorizes API calls; reload/back
      navigation does not reveal cached private content to a signed-out or different user.
- [ ] With the target's mail settings, receive actual verification and password-reset
      messages in a controlled external inbox. Resend works within rate limits; expired
      or reused links fail; recovery responses do not reveal account existence. Managed
      sign-in requires verified mail; self-host behavior matches its configured policy.
- [ ] Change and reset a password. Existing sessions and pending factor challenges
      are revoked as documented; a saved schedule is not cancelled by signing out.
- [ ] Enroll an authenticator only after password verification and a valid code. Exercise
      factor sign-in, wrong codes, one-use backup codes, replacement-code invalidation,
      and password-verified disabling. Password reset does not bypass the second factor.
- [ ] Exercise sign-in and mail rate limits across API instances on isolated fixtures.
      Spoofed forwarding headers do not bypass limits; legitimate access recovers after
      the documented limit window.

## Membership, authorization, and isolation

- [ ] Invite, resend, accept, revoke, and expire invitations. Wrong-address and replayed
      acceptance fail; verification is required; seat usage and release follow the
      documented installation policy.
- [ ] Test Owner, Admin, Editor, and Viewer against both UI controls and direct API calls.
      Editors can compose/publish but not administer; Viewers cannot mutate; Admins cannot
      perform Owner-only lifecycle actions or escalate their own permissions.
- [ ] Suspend/reactivate a member, change a role, remove membership, and delete a fixture
      account. Subsequent access reflects the change without relying on hidden buttons;
      affected sessions are revoked where required and unrelated members remain usable.
- [ ] Transfer installation ownership with reauthentication. The new Owner gains the
      intended authority, the previous Owner loses Owner-only powers, and Audit records
      the action. Exercise documented break-glass recovery on an isolated clone.
- [ ] With two isolated Workspace fixtures, attempt cross-tenant reads and writes using
      known Post, Asset, Channel, Brand Profile, Queue, invitation, and Distribution IDs.
      API and database policy deny access; responses and caches do not leak the other tenant.
- [ ] Create, rename, recolor, and delete a Brand Profile. Validate duplicate/invalid
      names, role restrictions, confirmation scope, and the documented effect on owned
      data. Reload preserves changes; retained history does not become unauthorized data.
- [ ] Rename the Workspace and inspect membership/Audit in Settings. Reload and a new
      session preserve the change; completing onboarding later does not overwrite it.

## Channel connections and real Provider acceptance

Repeat applicable checks for **every advertised Provider and publishing method**.
Use [publishing controls](../frontend/public/content/docs/publishing.mdx) to enumerate
methods; an accepted basic post does not certify Stories, Live, inbox delivery, or
other advanced modes.

- [ ] Verify real credentials, callback origins, scopes, app review and account eligibility
      for the advertised audience, not just app-role test users. An acceptance flag is set
      only after evidence exists. Unaccepted Providers remain unavailable in UI and API.
- [ ] Complete OAuth with single- and multi-account grants. The selection view exposes only
      authorized accounts; confirming assigns the intended account to the selected Brand
      Profile without silently changing ownership or duplicating a Channel.
- [ ] Deny consent, omit required scopes, return an expired/replayed callback, and interrupt
      the popup/redirect. The app reports an actionable outcome without consuming another
      user's authorization or losing the original composition.
- [ ] Reconnect an expired/revoked Channel and exercise token refresh. A concurrent refresh
      does not corrupt credentials; changed permissions update available publishing choices.
- [ ] Disconnect a Channel with pending work. Future delivery follows documented cancellation
      semantics, Provider-owned outcomes remain truthful, and existing platform copies remain.
- [ ] Complete one immediate and one deferred publication for every supported Provider/method
      and media combination. Confirm destination, caption, media/order, visibility, audience,
      and account-specific options in the native Provider, not only Meltiply's success badge.
- [ ] For native drafts, inbox handoffs, experiments, or prepared broadcasts, confirm the
      native outcome and terminal **Delivered** state rather than fabricated **Published**.
      Warnings from secondary shares or partial content remain visible without duplicating
      a successful primary publication on retry.
- [ ] If Live is advertised, verify writer-only credential access, no credential caching or
      logging, a real external encoder/native broadcast, and idempotent broadcast ending.
      Preparing a broadcast alone is not proof that it went live.

## Composition, media, and Post collections

- [ ] Save/reopen a text draft without Channels; save ordered attachments and per-Channel
      options; edit and reload. Nonempty-content validation is consistent in UI and API;
      incomplete draft choices persist but cannot bypass publication validation.
- [ ] Upload supported images and videos through actual processing and preview/download.
      Exercise invalid type/size, corrupt media, interrupted transfer, processing failure,
      and retry. Errors retain the editable Post instead of inventing a ready Asset.
- [ ] Exercise each advertised storage backend using its real endpoint. Private Assets
      cannot be fetched anonymously or across tenants; signed capabilities expire and
      cannot authorize different objects or operations.
- [ ] Verify Provider-specific attachment counts, media restrictions, caption limits,
      required audience/privacy/disclosure choices, and unavailable interactions. Invalid
      options are rejected before creating publishable work, including direct API requests.
- [ ] Create and resolve signature templates by Brand Profile, Platform, and Channel.
      Validate the final caption including the signature; later template edits do not
      rewrite existing Posts, explicit no-signature choices, or queued snapshots.
- [ ] Compose for multiple Brand Profiles. Partial saves/queueing retain successful Post
      identities; retrying unchanged failed portions does not duplicate completed copies.
- [ ] Compare Table, Calendar, Grid, and Post details for the same records. Exercise search,
      filters, grouping/columns, selection, pagination/Load more, navigation, and reload;
      selection and counts refer to authorized records, not hidden or fabricated results.
- [ ] Delete a fixture Post individually and in a partial-failure batch. Successful deletions
      disappear from all views after reload; failed rows remain actionable; retained
      Distribution history does not resurrect the Post or delete native platform copies.
- [ ] Interrupt an edit or trigger a recoverable request failure. Unsaved intent, selected
      destinations, pending/error feedback, and focus are preserved as documented.

## Scheduling and weekly Queues

- [ ] Publish with Now and schedule a future Post. Close the browser and sign out; server-side
      delivery still occurs at the intended instant. Verify actual Cron dispatch in the
      managed target, not just a fixture route that invokes the handler.
- [ ] Set the publishing timezone, create/edit a midnight schedule, and reopen it from
      Calendar and Post details. Changing the preference changes presentation, not an
      existing stored instant. Invalid or past schedules receive the documented response.
- [ ] In isolated fixtures, cover DST gaps/overlaps and boundary instants for manual
      schedules and weekly Queues. Compare stored instants with documented timezone
      semantics rather than changing the clock of a live installation.
- [ ] Create/edit/retire a named Queue with validated slots and an IANA timezone. Admins
      configure, Editors/Admins enqueue or remove safe pending work, and Viewers only read.
- [ ] Enqueue concurrent Posts and retry the same enqueue request. Each intended Post gets
      one immutable future assignment without overbooking or duplicate delivery; Queue
      mode respects the owning Brand Profile.
- [ ] Change Queue slots/timezone after allocation and remove an unclaimed Post. Existing
      assignments do not shift; removed reservations are safely released; retirement with
      unresolved work is rejected and historical membership is retained.
- [ ] Cancel or reschedule pending work, including a race with consumer claim. The action
      succeeds only when safe; already Provider-owned work cannot be falsely cancelled.

## Delivery failures, idempotency, and recovery

Use controlled faults on an isolated installation; do not intentionally exhaust a
real Provider's quota or crash a live installation to complete this section.

- [ ] Deliver the same message/webhook/request concurrently and after a restart. Domain
      effects are idempotent and do not create duplicate native publications or outcomes.
- [ ] Inject transient network errors, Provider throttling, and temporary dependency
      outages. Backoff respects the failure class; eventual recovery reaches a truthful
      terminal state without an unbounded hot loop.
- [ ] Inject deterministic rejection, revoked credentials, and exhausted retries. The UI
      distinguishes actionable failures, channel reconnection, and DLQ quarantine; retry
      targets only eligible failed work and leaves successful destinations untouched.
- [ ] Simulate Provider success followed by a lost response. Reconciliation follows the
      Provider's ambiguity policy; it neither fabricates failure/success nor blindly
      republishes an operation whose outcome is unknown.
- [ ] Crash after durable commit and during claimed processing. After the documented
      lease/recovery window, committed jobs and workflows resume without loss or duplicate
      external effects. Normal graceful shutdown also preserves long-running media work.
- [ ] Correct a poison-message cause and replay a bounded DLQ batch using the documented
      operator path. Authorization, queue selection, audit/evidence, and resulting
      terminal outcomes are correct; unrelated messages remain quarantined.
- [ ] Verify mixed-success multi-Channel Posts. Row status, filters, detail results,
      cancellation, deletion protection, retries, and notifications preserve each
      Distribution's independent state.

## Analytics, settings, notifications, and privacy

- [ ] Compare Post and dashboard metrics with known stored Provider snapshots. Verify
      published-cohort/time filters, Brand Profile aggregation, ranking/pagination, and
      no double counting across destinations. Missing/unsupported metrics are unknown,
      not fabricated zeroes; stale, awaiting-sync, partial, and empty states are distinct.
- [ ] Change theme, language, timezone, signatures, and notification preferences; reload
      and sign in again. Values persist at their documented scope; changing identity
      cannot reuse another user's private in-memory results.
- [ ] Deliver each enabled failure/disconnection notification to the explicit configured
      external recipients. Disabled events send nothing; invalid/multiple recipients,
      delivery failure, and retries follow the documented preferences without leaking secrets.
- [ ] Reporting starts off on fresh installs and upgrades. Only the Owner can opt in/out;
      members see effective policy. Missing destination, operator forced-off, and receiver
      outage do not disable product workflows.
- [ ] Exercise usage and diagnostics separately with a controlled receiver, then withdrawal
      with pending retries. Unsent reports are suppressed after withdrawal; payloads match
      the [reporting allowlist](improvement-reporting.md) and exclude private content and
      credentials. Skipping feedback sends nothing; explicit sharing does not link it to
      the installation's usage identity.

## Device authorization and browser usability

- [ ] Exercise the [device protocol](device-authorization.md): signed-out return through
      sign-in/2FA, code/account/role review, explicit approval and denial, expiry, wrong
      claiming session, polling slowdown, and single-use redemption. Visiting a link alone
      never approves; device secrets never appear in the browser URL or shared evidence.
- [ ] The resulting CLI session has the approving member's current permissions, not
      requested extra privileges. Revoking it leaves the browser usable; suspension,
      password/factor changes, and session expiry enforce the documented revocation policy.
- [ ] Exercise onboarding, connection, composition, scheduling, Queue calendars, Post
      outcomes, Settings, and recovery in both palettes at desktop and phone widths.
      Keyboard focus/escape/return, labels, screen-reader announcements, touch access,
      scrolling, long translations, and native reduced-motion behavior remain usable.
- [ ] Force empty, loading, validation, offline, server-error, and expired-session states.
      Controls reflect actual pending outcomes, status is not color-only, and recovery
      does not silently discard work or show optimistic publication success.
- [ ] Open direct/unknown/retired routes, invitation/device links, landing samples, and
      public guide/search links. Redirects remain same-origin and preserve valid return
      paths; public samples cannot persist Posts or imply real publication.

## Deployment, upgrade, rollback, and restore

Complete the target-specific branch for each deployment target advertised by this
release. Follow the linked runbook for commands and approvals rather than improvising
from this checklist. Use isolated clones for destructive recovery drills.

### Managed Cloudflare

- [ ] Follow the [managed runbook](../infra/cloudflare/README.md#release-and-rollback)
      for a fresh installation and an update from the previous deployed revision. Verify
      environment separation, least-privilege credentials, protected inputs/state, real
      resource bindings, TLS, mail, and disabled fixture/operator exposure.
- [ ] Capture a real restore point before migrations and exercise expand-only upgrades
      with previous and candidate code. Queues and Cron stay paused through candidate
      smoke and domain attachment; secret-bearing versions activate after injection.
- [ ] Verify frontend and API candidate identities, the reviewed domain transition, and
      every API traffic stage with matching live smoke. Stop on any failed stage; only
      resume Queues and activate Cron after acceptance and the required review receipts.
- [ ] Drill code rollback with compatible persisted state, and recovery from failure
      between Queue resume and Cron activation. Reconcile any delivered work; do not
      assume Worker rollback reverses database, R2, Queue, Workflow, or Durable Object state.
- [ ] Restore the Neon snapshot into an isolated branch and exercise the matching
      application revision. Verify the documented recovery strategy for media and
      asynchronous state separately; a database restore alone cannot recover or undo
      R2 objects, Queue deliveries, Workflows, or Durable Object changes.
- [ ] Validate the final redacted release manifest against the real selected installation;
      preserve private recovery evidence securely and publish only its allowed evidence.

### Self-hosted Compose

- [ ] Follow [production self-hosting](self-hosting.md) from an empty host using the exact
      published images and matching Compose revision, with no local build fallback. Pull
      and start every advertised architecture using matching immutable tags for all images.
- [ ] Verify public HTTPS, callback origins, configured SMTP/verification policy, database
      roles/migrations, storage, and persistent volumes. Internal services, admin sockets,
      and secrets are inaccessible from the public network.
- [ ] Upgrade a populated installation from the previous revision. Migrations apply once;
      accounts, encrypted credentials, Posts, media, queued work, and workflow state survive
      container recreation. Exercise compatible rollback rather than assuming migrations undo.
- [ ] Take a consistent database/runtime-volume/configuration backup with writes stopped,
      preserve encryption keys, and restore a matching revision into an isolated clone.
      Sign in, decrypt a controlled Channel credential, fetch media, and resume cloned
      queued/workflow work against controlled destinations without contacting real users.
- [ ] Measure backup age and restore duration at representative data volume; compare them
      with the operator's agreed data-loss/recovery-time limits. A tiny CI restore is not
      proof of production recovery capacity. Retain volumes during ordinary shutdown.

## Operations and release decision

- [ ] Assign an operator and recovery contact; verify access to backups, credentials,
      release evidence, and the documented incident/replay/Owner-recovery procedures.
- [ ] Exercise readiness failure, application/Provider failure, queue backlog and age,
      DLQ growth, stalled processing, and capacity alerts with controlled faults. Alerts
      reach a real recipient and distinguish intentionally delayed jobs from late work.
- [ ] Run representative concurrent composition, upload, scheduling, delivery, and analytics
      traffic. Agree and record latency, schedule-lateness, backlog-drain, storage/disk,
      database-connection, and cost limits; measurements meet them without cross-tenant
      starvation, unbounded work, or unexplained error growth.
- [ ] Complete a closed-browser deferred-publication observation across at least one real
      scheduling/maintenance cycle. Compare durable outcomes with native Provider state
      and inspect recovery, mail, logs, queue health, and resource usage afterward.
- [ ] Reconcile logs, errors, support exports, client bundles, and shared artifacts for
      credential/private-data leakage. Validate restrictive origins, authorization on
      operator routes, private storage, and production-only entrypoints.
- [ ] Review release notes, known limitations, supported Provider/method combinations,
      install/upgrade instructions, public guides, and source/license artifacts. Claims
      match the actually accepted scope; contract publication follows the
      [protected-tag procedure](../packages/contracts/README.md#prepare-and-publish).
- [ ] Every applicable check has evidence; exclusions are explicit and unavailable
      capabilities stay unavailable. No unresolved data-loss, isolation, authorization,
      duplicate-publication, false-success, or recovery defect remains; other release
      blockers have an explicit disposition rather than being hidden by a green CI gate.
- [ ] The release owner records the go/no-go decision, accepted scope and limitations,
      rollback/forward-recovery path, and evidence references. Switch `STATE.md` to
      `production` only when acceptance is signed off and live persistent operation begins.
