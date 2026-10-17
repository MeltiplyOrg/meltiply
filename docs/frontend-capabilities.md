# Frontend capability inventory

This document records the current creator-facing interface. Backend endpoints and reference-design examples do not imply a shipped screen. Use [UI ownership](frontend-ui.md) and [layout](frontend-layout.md) for implementation; [`COMMUNITY_LIMITS`](../packages/domain/src/index.ts) owns resource policy.

## App surfaces

| Surface                        | Current workflow                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sign-in`                     | Protected first-run creation of the installation's single owner, owner sign-in, verification resend, password recovery, and optional authenticator/backup-code challenge. Setup closes after owner creation.                                                     |
| `/posts`                       | Compose/save Posts, manage ordered attachments and channel settings, schedule/publish, inspect independent Channel outcomes, retry eligible failures, cancel pending delivery, and confirm deletion. Toolbar order is Table → Calendar → Grid; Table is default. |
| `/channels`                    | Members-style Accounts directory and Brand Profiles tab. Real identity, ownership, health, recovery, settings/copy/disconnect, profile management for admins, and explicit Facebook Page selection. Connection availability follows server readiness.            |
| `/settings`                    | Appearance with Light/Dark/System, English/Spanish interface selection, read-only Account/workspace identity, Sign out, and inline password-verified Security. All sections share one layout/content maximum.                                                    |
| Shell                          | One Posts entry, one Channels entry, Settings/help/account access, read-only workspace identity, collapsible desktop rail, responsive navigation dialog, and top-bar jump search.                                                                                |
| `/`, unknown/retired app paths | Redirect to Posts, then through authentication when required. Retired paths do not retain preview screens or compatibility aliases.                                                                                                                              |

## Collection behavior

- Table, Calendar, and Grid share Post identity and real publishing state. Table grouping/columns change presentation; Calendar uses real dates and explicit scheduling entry. There is no drag-rescheduling contract.
- Profile selection lives in collection filters or jump search, not sidebar sections. All Brand Profiles is aggregate review; composition/publishing requires one owning profile.
- Field-row filters use supported equality predicates. Top-bar jump search covers pages and loaded profiles; route search covers the current collection, not a global index.
- Selection belongs to loaded authorized records and survives view/filter/group presentation changes. Select-all is visually checked only for the whole visible set. The shared pill reports the real count; confirmed batches remove successes and retain failures.
- Post inspection uses the canonical edge/phone drawer and real properties, caption, attachments, and Channel outcomes. Composing and editing open the same drawer, whose footer pins Save, Schedule, and Publish Now in view. Deleting a stored Post or disconnecting a Channel does not remove published platform copies.
- One animation implementation is retained. There is no separate motion mode, preference provider, root flag, or alternate-mode branch.

## Public surfaces

The landing page explains supported publishing workflows using clearly labeled local sample content; that sample cannot publish or persist authenticated workspace Posts. Public guides cover setup, ownership, Channels, composition/media, publishing, Settings, recovery, quotas, and legal/storage policy.

Public article search uses its build-time documentation index and a canonical shared trigger/dialog. It is separate from app jump search. Landing, docs, and app share palette/fonts, while keeping their own product-explanation, reading, and operating layouts.

## Not shipped in the interface

| Capability                               | Current boundary                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace switching                      | Identity is read-only; the active session resolves the workspace.                                                                                  |
| Time-slot Queues                         | Manual Schedule/Publish Now only. Queued is a delivery state, not membership in a recurring named schedule.                                        |
| Engagement analytics                     | No Post engagement fields or app analytics dashboard; inspect native platform metrics. Backend analytics APIs are not a UI.                        |
| Inbox/replies                            | No in-app comment reader or reply workflow; use the native platform. Backend syncing does not create an app route.                                 |
| AI Studio/Plugs                          | No simulated assistant, recommendation, integration directory, or automation configuration screen.                                                 |
| Team/admin/billing                       | No invitations, membership administration, checkout, portal, payment integration, or notification configuration. Settings is not an admin console. |
| Standalone media library                 | Uploads and attachment selection belong to a Post composition.                                                                                     |
| Profile restore                          | No deleted-profile browser or restore control. Backend retention operations do not imply self-service recovery.                                    |
| Identity editing/custom appearance modes | Account identity is read-only; there are no custom accent, density, layout-mode, or motion-mode settings.                                          |

Adding a capability requires an explicitly approved, authorized end-to-end workflow with real data, meaningful pending/error/empty states, scope isolation, updated guides, and actual-surface verification. Do not restore a demo control merely because its API or reference markup exists.
