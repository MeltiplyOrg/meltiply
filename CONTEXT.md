# Meltiply

Meltiply is a multi-platform publishing workspace. Creators compose posts with
their media, connect accounts on social networks, schedule and monitor
publishing, review analytics, and reply to audience comments from one workspace.

This glossary fixes the words used for those concepts. It is not a spec: it says what
each term _is_, not how it is implemented.

## Publishing

**Platform**:
A destination social network Meltiply publishes to, such as TikTok or YouTube.
_Avoid_: channel, network, provider, social

**Provider**:
Meltiply's integration with one Platform — the thing that holds its credentials,
capabilities, and call semantics. A Platform is the destination; a Provider is our
means of reaching it.
_Avoid_: connector, client, integration, platform

**Platform account**:
A creator's connected account on one Platform, held by exactly one Brand Profile. The
user interface calls a Platform account a Channel.
_Avoid_: connection, social account, provider account

**Channel ID**:
The identifier a Platform assigns to a Platform account, often numeric but not
necessarily so; it is neither the account's username nor Meltiply's record identifier.
_Avoid_: username, handle, display name

**Channel username**:
A Platform account's user-facing `@` handle, usually chosen by its owner when
the Platform supports one; it is distinct from its Channel ID and display name.
_Avoid_: channel ID, display name

**Platform capability**:
The declared record of what one Platform permits — accepted asset types, caption
length, hashtag count, media limits. It is the single authority on those limits.
_Avoid_: constraints, rules, config, features

**Asset**:
A piece of media a creator has uploaded and Meltiply has stored, together with
its lifecycle state. Assets are binary storage infrastructure owned by Posts;
Meltiply has no standalone media library.
_Avoid_: video, file, upload, media, object

**Post**:
One durable composition and publication intent owned by a Brand Profile: its
default text, ordered attachments of Assets, saved target settings, and
lifecycle state. A draft is a Post's lifecycle state, not a separate type.
_Avoid_: publication, draft, campaign

**Distribution**:
An intent to publish one Post to one Platform account, together with everything
that intent needs and whatever became of it.
_Avoid_: post, publication, job, target

**Reply**:
A response a creator sends to a Comment on a published Distribution.
_Avoid_: answer, response, message

**Comment**:
Audience feedback retrieved from a Platform against a published Distribution.
_Avoid_: engagement, interaction, mention

**Inbox**:
The surface where a creator reads Comments and sends Replies.
_Avoid_: engagement view, messages, feed

## Workspace and entitlement

**Workspace**:
The tenant that contains Brand Profiles and Usage records, and the unit that all
tenant-scoped access is isolated by.
_Avoid_: organization, org, team, tenant, account

> **Naming seam.** Use Workspace in module names, types, variables, UI copy, and
> documentation. Below the persistence seam the established internal names are
> `org_id` / `org_role`; native Workspace membership supplies their values.
> This seam is intentionally internal rather than an external identity-provider contract.

**Brand Profile**:
A named, color-labelled identity within one Workspace that can carry an optional short
description and owns its Posts, Assets, Platform accounts, Distributions,
analytics, and Inbox activity. A Workspace can contain multiple Brand Profiles.

**Usage record**:
A durable measurement of Workspace consumption used to enforce resource limits.
_Avoid_: metric, quota row, counter

**Workspace quota**:
A limit on the uploads, publication distributions, connected Channels, or storage a Workspace may consume, measured over the applicable usage period or current occupancy. It is separate from a User's authorization to act in that Workspace.
_Avoid_: paid plan, subscription tier, entitlement, permission

**Operator**:
A Meltiply staff member acting on a Workspace through the operator surface, whose
actions require durable audit evidence.
_Avoid_: admin, support, staff

## Asynchronous work

**Outbox**:
The durable record of intent written in the same transaction as the domain state that
caused it, so that asynchronous work can never disagree with committed state.
_Avoid_: event log, queue table, dispatch table

**Schedule**:
The time a creator has chosen for a Distribution to publish. It is domain state a
creator can read and change, not an internal timer.
_Avoid_: timer, cron, scheduled job

**Queue**:
A named reusable publishing plan whose recurring weekday/time slots determine
when its ordered Posts publish, rather than requiring a manually chosen time
for every Post. This product concept is distinct from an asynchronous transport queue.
_Avoid_: scheduled filter, Schedule, Cloudflare Queue

**Due work**:
Work that becomes actionable at a known future moment — a Schedule arriving, a retry
falling due, a sync cadence elapsing. The moment is always recorded durably; any
queue message that announces it is a trigger, never the record itself.
_Avoid_: job, timer, pending task, tick

**Provider attempt**:
One bounded try at a Provider operation for one Distribution or Reply, including its
exclusive claim, its outcome, and whether that outcome is certain.
_Avoid_: job, task, run, execution, operation

**Ambiguous outcome**:
A Provider attempt whose side effect may or may not have happened. It is neither
success nor failure and must never be retried as though it were a failure.
_Avoid_: unknown, indeterminate, partial failure

**Reconciliation**:
Re-establishing what a Platform actually did after an Ambiguous outcome or a missed
confirmation.
_Avoid_: sync, repair, healing, cleanup
