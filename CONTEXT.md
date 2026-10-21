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
tenant-scoped access is isolated by. An installation hosts one shared Workspace
for its team; personal Workspaces are retired.
_Avoid_: organization, org, team, tenant, account

**Installation Owner**:
The single account that bootstrapped the installation and holds
installation-level authority: transferring ownership and suspending,
reactivating, or deleting accounts. Ownership is separate from Workspace
roles; the Owner always holds the Admin role in the shared Workspace.
_Avoid_: superadmin, root, owner account, personal workspace owner

**Workspace member**:
An account with an active membership in the shared Workspace.
_Avoid_: user, seat, teammate

**Workspace Admin**:
The Workspace role that manages Brand Profiles, Channels, members, invitations,
settings, and Audit. Admins cannot assign or modify another Admin.
_Avoid_: owner, superadmin

**Editor**:
The Workspace role that creates and edits Posts, uploads Assets, schedules and
publishes, retries or cancels Distributions, and replies to Comments. Editors
read Channels and Brand Profiles but cannot configure them.
_Avoid_: member, creator, writer

**Viewer**:
The Workspace role with read-only access to Posts, Channels, analytics, and
Inbox.
_Avoid_: guest, read-only member

**Invitation**:
A single-use, seven-day, hashed-token offer to join the shared Workspace at a
specific email address and role. Pending invitations reserve Seats.
_Avoid_: invite, request, onboarding link

**Seat**:
One unit of installation capacity. The limit is ten active members including
the Installation Owner; pending invitations reserve Seats and suspension or
revocation releases them.
_Avoid_: license, user limit, quota

**Suspended member**:
A member whose sign-in and sessions are blocked while their membership and
content attribution remain. Suspension releases the Seat.
_Avoid_: banned user, disabled account, deleted account

**Audit entry**:
An append-only Workspace record of an administrative action: actor identity
snapshot, action, target, before/after state, request id, and timestamp.
_Avoid_: log line, activity, event

> **Naming seam.** Use Workspace in module names, types, variables, UI copy, and
> documentation. Below the persistence seam the established internal names are
> `org_id` / `org_role`; native Workspace membership supplies their values.
> This seam is intentionally internal rather than an external identity-provider contract.

**Installation Owner**:
The person who owns a Meltiply installation and administers its user accounts,
invitations, and Workspace creation. Content access follows ordinary Workspace
membership; an Installation Owner is not an Operator.
_Avoid_: superadmin, admin, owner

**Workspace member**:
A person with an active membership in a Workspace. Every member holds exactly one
Workspace role.
_Avoid_: user, seat, collaborator

**Workspace Admin**:
A Workspace member who manages the Workspace's members, settings, Brand Profiles,
and Channels, in addition to acting on its content.
_Avoid_: owner, manager, operator

**Editor**:
A Workspace member who creates, edits, schedules, and publishes content and
replies to Inbox activity, but does not manage members, settings, Brand Profiles,
or Channels.
_Avoid_: creator, publisher, contributor

**Viewer**:
A Workspace member with read-only access to the Workspace's content and Channels.
_Avoid_: guest, observer, read-only user

**Invitation**:
An email-bound offer to become a Workspace member with a specific role. Only the
invited address may accept it.
_Avoid_: invite link, request, signup

**Seat**:
One of the installation's ten active Workspace member places. A pending
Invitation reserves a Seat; a suspended member releases one.
_Avoid_: license, slot

**Suspended member**:
A Workspace member whose sign-in is blocked and whose Seat is released while
their data and history remain.
_Avoid_: deleted user, inactive account

**Audit entry**:
A durable record of an administrative action, including its actor, target, and
what changed.
_Avoid_: log line, event

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
