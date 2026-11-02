# Shared UI ownership and reuse

The interface adapts [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio) at
`904205c626918ee96054eb35495c394a60c0c601`. Source reuse was authorized for this
redesign; upstream publishes no general license, so its availability is not a grant
to third parties.

Use [product UI intent](../PRODUCT.md#modular-consistent-surfaces) for behavior, the
[visual system](../DESIGN.md) for reusable design rules, [layout](frontend-layout.md)
for geometry/scroll boundaries, and the [capability inventory](frontend-capabilities.md)
for shipped workflows. Components and [`tokens.css`](../frontend/shared/tokens.css)
are implementation truth; reference demo features are not product requirements.

## Canonical owners

| Responsibility                                               | Owner                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Palette, self-hosted Geist fonts, density, radius, elevation | `frontend/shared/tokens.css` and shared CSS entrypoints                    |
| Buttons, fields, menus, tabs, tables, dialogs, feedback      | `frontend/shared/src/components/ui`                                        |
| Shared status, navigation, and selection atoms               | `frontend/shared/src/components/atoms` and `primitives`                    |
| Static Astro controls and the faceted brand mark             | `frontend/shared/src/components/public`                                    |
| Icon sizing/hover/animation loop                             | `frontend/shared/animated-icons/icon-motion-frame.tsx`, `use-icon-loop.ts` |
| Theme, consent, clipboard, toast store, animation recipes    | Existing modules in `frontend/shared`                                      |
| Navigation roster, jump search, Settings, collection state   | `frontend/app/src/components`, owning context/hooks                        |
| Loading placeholders and boot frame                          | `layout/workspace-loading-skeleton.tsx`                                    |
| Document and nested-container smooth scrolling               | `layout/smooth-scroll.tsx`                                                 |
| Sidebar/Settings sign-out                                    | `hooks/use-workspace-sign-out.ts`                                          |
| Public article search                                        | `frontend/public/src/components/search.tsx`                                |
| Documentation tree, public content                           | `frontend/public/src/components`, `content/docs`                           |

Read [`@meltiply/ui` exports](../frontend/shared/package.json), the implementation,
and a real caller before changing a control. Import explicit subpaths
(`@meltiply/ui/button`). Shared modules never import app internals; feature owners
supply authorized data, labels, pending state, and actions.

## TypeScript, React, and styling

Strict TypeScript/TSX, React, Tailwind utilities, semantic tokens, `cn`. Extend a
canonical variant or compose from existing primitives; keep finite style maps outside
render functions. Shared CSS owns global reset/focus, tokens, and browser
interoperability; public Astro/Fumadocs adapters use the same tokens.

Canonical `Button`, `Input`, `Textarea`, `SelectTrigger`, and menu rows adapt to
coarse pointers rather than inferring input type from screen width. Buttons, selects,
menu rows, and segmented items hold 44px minimum heights; text fields keep 16px text.
Shared safe-area tokens supply shell/drawer insets without page-specific spacing.

Remove replaced callers, aliases, local re-exports, duplicate wrappers, and
unconsumed selectors during cutovers. Keep real API adapters distinct when endpoint
contracts differ; deduplication is not a reason to invent a generic abstraction.

There is one implemented animation path. New animation work extends the shared
owners. Native reduced motion is an accessibility contract: shared WAAPI effects skip
spatial travel under `prefers-reduced-motion: reduce`.

## Shared visual grammar

Warm flat page/navigation fields, opaque content surfaces, the shared three-step ink
ramp, theme-independent geometry. Indigo/periwinkle marks actions and focus; selected
navigation is neutral. Semantic states carry labels or accessible icons; platform
colors identify providers, never product state.

Geist is the working face, Geist Mono for code, identifiers, and shortcuts. Interface
glyphs use canonical Lucide; retain Meltiply's faceted mark and real provider
identity. Use named radius/elevation tokens and one intentional surface boundary, not
duplicated borders/rings or a separate page palette.

## Navigation, search, and filters

`frontend/app/src/lib/navigation.ts` owns `WORKSPACE_NAV_ITEMS` and route resolution:
Posts → Analytics → Channels → Queues as `primary`, Settings as the `utility` footer
destination. The rail, mobile drawer, jump search, and header title all read that one
record. View selection and Brand Profile scope belong to collections. Workspace
identity is read-only.

`SidebarNav`, `MobileNavigationSidebar`, and `NavigationShell` own the rail, header,
mobile navigation layer, Settings/help/account access, and workspace context.
`MobileNavigationSidebar` renders the same `SidebarNav` with `collapsible={false}`
as a fixed left-edge layer behind a fading scrim — not a reduced copy of its
destinations.

`SidebarGlideHighlight` (`@meltiply/ui/sidebar-glide-highlight`) owns the rail's hover
background: every `data-sidebar-item` row is a target and one pill springs to the
hovered row. Settings' section rail and the public docs rail reuse it with their own
containers. `SlidingHighlight` (`@meltiply/ui/sliding-highlight`) owns every highlight
that travels _between_ items: it measures the active item, writes that box as static
geometry, and animates only transforms. Menus, tab strips, theme segments, and
segmented selections drive it through their own state attributes.

The footer uses one compact avatar/name account trigger with trailing chevrons and an
avatar-only collapsed state. Its menu holds the real name/email, Account settings,
inline Light/Dark/System segments, and Sign out; theme changes apply immediately
without dismissing the menu through the same consent-aware owner Settings uses.

`WorkspaceSearch` is a jump palette over supported pages and loaded profiles, opened
from the top bar or `hotkeys.commandMenu`. It is not a global Post index. Route
toolbars own collection search and the current Brand Profile filter.
`TopToolbarFilters` owns the shared field-row disclosure: Where/and rows, Add filter
chips, equality controls, per-row removal, Clear all, and active-value chips. Routes
supply localized field metadata, real predicates, and reset callbacks. Empty added
rows do not filter data; removing or adding rows restores useful focus.

Tooltips use the reference-derived compact inverse treatment; Radix owns focus,
Escape, collision, and portals. Keyboard hints supplement accessible names.

`DropdownMenu` and `Select` render one menu vocabulary from `frontend/shared/motion.css`
(`data-menu-surface`, `[data-menu-item]`, `[data-menu-indicator]`, `[data-menu-label]`,
`[data-menu-separator]`), so every menu and listbox in the app stays identical. An
anchored surface inherits the trigger box as a minimum width
(`data-menu-fit-trigger`); icon-triggered action menus keep the shared 200px floor.
Extend these wrappers instead of restyling a surface.

## Collections and selection

Posts orders **Table → Calendar → Grid**, Table default. All three share Post
identity, owning Brand Profile, real outcomes, filtering, and supported actions;
grouping and column visibility are presentation, not a different data model.

Posts Table and its Columns menu share `postAnalyticsColumns`. `Post.analytics`
carries one batched sum of each published Channel's latest stored snapshot — not
historical sums, not a request per row. Real zeros render as zero; drafts,
non-published Posts, absent snapshots, and untracked counters render `-`.
Saves/Clicks stay null.

`usePosts` owns an infinite-query cache of 60-record server pages. Grid slices the
filtered loaded collection into pages; Table appends explicitly requested pages. Both
reuse the same browser-memory cache across view/route navigation, retain inactive
pages for 30 minutes, and share mutation invalidation and active-publication polling.
Cache is never written to persistent storage and is discarded with the
user/workspace query-provider boundary. A failed next-page read keeps loaded records
and selection and exposes retry.

Active and due work refreshes every ten seconds through bounded detail reads; when
active identities outnumber loaded pages, the owning collection refreshes its page
chain once instead of one request per Post. A pending Load more is not canceled.
Disappeared Posts are checked individually before clearing other projections;
interior page absence is not proof of deletion. Publication invalidates stored
Analytics.

`usePlatformCapabilities` retains one successful deployment-defined result for the
lifetime of the current identity/Workspace-scoped QueryClient (`staleTime` and
`gcTime` infinite for that query only). Sign-out, scope replacement, or a full reload
creates fresh query state. The general freshness default stays 60 seconds;
Channel/reference lists and stored Analytics reuse successful reads for five minutes.
Mutations invalidate affected reads; Analytics Refresh advances its shared cohort.

Queues extends `PostCalendarGridView` rather than adding a second month grid.
`CalendarTimeGrid` owns hourly Week geometry and current-time paint; `QueueCalendar`
owns Queue timezone, bounded paged reads, live clock, and reservation actions.
`post-row.ts` projects real Post/Channel data for both routes. Desktop Queue
navigation uses neutral Buttons and `SidebarGlideHighlight`; phones use a compact
Select with the same administrator actions.

`QueueTimezonePicker` owns timezone selection: the finite browser IANA catalog plus
`UTC` and the saved alias, ranked by substring then ordered character gaps. The panel
renders **inline** under its trigger, not in a portal — a portalled list inside a
modal dialog has wheel events cancelled by the dialog's scroll lock. Search never
commits (Enter must not submit the Queue form); choosing an identifier closes the
panel; Escape belongs to the panel while open.

Week chips paint over the hourly canvas, so they use the opaque
`--accent-tint-solid`/`--green-tint-solid`/`--red-tint-solid` twins rather than
translucent tints. The Queue editor bounds its Weekly slots list so a long plan
scrolls inside the dialog.

`calendarSlots` projects the validated weekly plan onto visible civil days for
display only: nonexistent DST occurrences are skipped and repeated hours use the
later instant. An exact-instant membership renders a filled slot with the real Post
chip; other projected occurrences render a dashed open slot, muted once elapsed.
Off-plan immutable reservations stay ordinary Post chips. The projection never
allocates, moves, or mutates work.

The red current-time rule paints only inside today's column and never spans the week.
Month↔Week changes commit through `transitionViewEffect` (native View Transitions):
only the seven surviving date labels keep a `view-transition-name`; the rest
crossfades and unsupported browsers or reduced motion commit immediately.

Post deletion soft-deletes the composition and stops pending delivery only; platform
copies and retained publication history survive. Both Post and Calendar reads exclude
soft-deleted Posts.

Channels follows the Members directory composition: Accounts/Brand Profiles tabs,
account search, status segments, field-row filters, identity table, profile cards.
Section tabs and status segments each use one travelling `SlidingHighlight`.
Connection cells carry one accessible health icon. Channel identity is a saved name
followed by one compact username/provider-ID line, copyable through the shared
clipboard helper with toast feedback; values truncate so adding a username never
grows the row.

`BulkSelectionBar` owns the inverse-ink floating pill, separators, count, action, and
icon-only Deselect. Callers own selection, confirmation, and mutations. Select-all is
checked only when the entire visible collection is selected; partial selection stays
unchecked while the pill reports the real count. Confirm a stable batch, then remove
successes and retain failures for retry.

## Settings and dialogs

`WorkspaceSettings` is a full route with Appearance, Language, Account, Security, and
— for administrators — Administration. Every section shares one background; the
preference and security sections use the bounded form column, Administration follows
the directory composition. Compact theme cards offer Light/Dark/System; System
follows live OS changes. Account identity is read-only. Security controls are inline
and keep password verification, authenticator enrollment, and recovery-code
requirements.

| Task                        | Primitive                                  |
| --------------------------- | ------------------------------------------ |
| Focused form or jump search | `CenterDialog`                             |
| Destructive confirmation    | `CenterAlertDialog`                        |
| Large Post inspection       | `SideDialog`                               |
| Modal phone navigation      | `CenterDialog` + `NavigationDialogContent` |

`CenterDialogContent` and `CenterAlertDialogContent` share `dialogChrome`: same
backdrop, geometry, elevation, radius, padding, header/footer, focus containment; only
intentional widths differ. The ordinary dialog keeps outside-click and Escape
dismissal with a localized Close. `AlertDialog` blocks outside dismissal, focuses
Cancel, and still cancels on Escape. Segmented controls follow the canonical
radiogroup contract: checked option is the only tab stop, Arrow keys plus Home/End
select and move focus.

`SideDialog` owns the edge/phone drawer geometry, compact record toolbar, Close,
native body scrolling, opener restoration, and the optional body-class hook a pinned
action bar needs. Post inspection shows properties, caption, ordered attachments,
stored analytics once a Channel has published, and independent Channel outcomes;
composing and editing open the same drawer, so no separate composer surface exists.
Chart chunks load lazily.

`NavigationDialogContent` extends the shared Radix dialog owner for the left-edge
phone rail: modal focus, nested Escape arbitration, scrim/Close dismissal, opener
restoration without scrolling, and the 300ms motion in shared `motion.css`.
`MobileNavigationSidebar` supplies only the existing `SidebarNav`, labels,
destinations, and desktop-breakpoint closure.

`FilterChecklist` in `@meltiply/ui/dropdown-menu` owns checkbox toggling, optional
aggregate clearing, stay-open selection, and Radix keyboard/dismissal behavior. Posts
status and `BrandProfileFilterSelect` use it alongside the canonical platform filter.
Composition reuses `BrandProfileFilterSelect` without an aggregate row: empty means
no selected profiles. `BrandProfileSelect` stays single-value for Channels scope.
Inspector focus restoration uses `preventScroll`.

`PostsDrawer` keeps an interrupted composition mounted in a hidden, inert section
while inspection takes presentation priority. Closing inspection or choosing its New
Post control resumes that live composition, including uploads, without functional
consent. Explicit dismissal releases it after the exit. Editing/scheduling
dependencies load lazily under a drawer-local Suspense fallback.

The composer uses `ComposerSection` for titled sections and `DestinationSelector` for
targeting. **Shared Content** leads the editor, then attached media, then each
selected Channel's region with caption overrides, attachment selection, and provider
settings — no composer tabs hide these controls. Wide panels give
destinations/publishing a 340px column and the editor the rest; the editor scrolls
independently. Narrow panels stack in DOM order inside the drawer's native scroll
body. The pinned action bar carries the real save state and the single action
resolved by publishing mode.

`DestinationSelector` keeps composition profile selection local, groups accounts by
provider, and identifies each account's owning profile. Selecting profiles never
changes the composition's anchor or discards inputs. `profile-copies.ts` coordinates
Post and upload mutations: one stable Post and separately owned media per selected
profile, target attachment remapping, all-drafts-before-scheduling, per-profile
progress, and unchanged-intent retry without rescheduling completed copies. Browser
recovery retains these identities only with functional consent. A single anchor
profile preserves the existing single-Post path.

A mounted composition keeps one async identity after its first save. Subsequent
single-Post edits recover under the saved Post id, so reopening restores unsaved
work. A multi-profile batch keeps copy identities together under the
new-composition key; learning an anchor copy id never moves progress to another
namespace.

Original-media reads use the canonical `lib/api.ts` binary adapter: a signed
object-store download never receives API bearer headers or session cookies. Failed
copy uploads release their sessions. A new draft write invalidates the previous
accepted delivery marker because saving cancels pending deliveries; only an unchanged
retry skips a completed profile. Readiness follows each Channel's selected
attachments, so unused media never blocks text-only delivery. Readiness reads and
polling share a five-minute per-profile deadline; expiry reports a failure and
retains the saved copy for retry.

Every account uses the same `ChannelAvatar` owner as the Channels directory: account
photo, initials when missing or failed, and a separate provider badge. Eligible
destinations start selected; explicit empty selection stays empty. The shared caption
uses bounded `Textarea autoGrow`, shows used/maximum code points from the tightest
selected capability, and clamps new typing without truncating restored drafts.

Queue mode uses the same selector plus the canonical Select for a named plan;
feature-owned queries enforce one owning Brand Profile. The Queues route composes
`WorkspaceSurface`, `CenterDialog`, `CenterAlertDialog`, Input, Select, and Button.
Its editor owns configuration and stable slot-row identities; the feature owns roles,
tenant scope, pagination, async outcomes, confirmations.

Channel caption fields are always available, inherit shared content until first
edited, and preserve intentional blanks independently of later shared edits. Only an
active override exposes **Remove Custom Override**. Destination cards show the
display name and platform on one line, then **Username: @handle** and
**ID: provider-assigned identifier** lines, including for unavailable accounts.
`ChannelIntegration.username` and `platformUserId` preserve the contract fields;
Meltiply's internal account id stays the selection key. Missing usernames say
**Username not provided** and are never inferred from a display name or id.

Each Channel's attachment mode uses the canonical `Switch`: off persists a text-only
target, on restores inheritance of all current/future attachments, and an explicit
non-empty subset keeps the switch on. `ProviderPanel` supplies an inline-size
container so TikTok's interaction/disclosure switches share one flat grid — two
columns when there is room, one on narrow panels. Provider capability metadata keeps
the adapters' canonical caption ceilings even when credentials are absent.

`ScheduleDateTime` shows a compact date button beside `TimeOfDayField` with the
browser time zone underneath. The same wall-time editor serves recurring Queue slots;
it accepts complete `HH:mm` values without timezone conversion. The date button opens
a Radix popover containing React DayPicker; coarse pointers get 44px day targets.
`@meltiply/ui/popover` owns anchored, non-menu form panels, including both scheduler
pickers. Date and time share one compact row; clicking the time field's background
focuses hours so a complete `HH:mm` can be typed, and the clock opens a compact
chooser with canonical Selects for all 24 hours and 60 minutes.

Primitives own accessible names, focus trapping, Escape/dismissal, scroll lock, and
transitions. Preserve content through exits with `useLatchedValue`; clear secrets per
the security lifecycle. Features compose a dialog rather than implementing a frame.

Inline Security uses the router's navigation blocker while a request is busy or
enrollment/recovery codes await completion. Section, route, and history changes
cannot discard that state; document departures show the unload warning. An allowed
departure clears local secrets by unmounting the section.

Use `@meltiply/ui/toast` and `@meltiply/ui/sileo` for transient outcomes with the
affected object and useful recovery. Clipboard feedback includes the copied value.
Keep inline validation and durable failures beside their controls. Accepted delivery
is not published success.

Copy resolves through `useI18n`: `t` for interpolated messages, `<Trans>` when a
placeholder carries a component. Both translate identically, including dev-only
pseudo-localization.

## Public surfaces and verification

Landing, docs, legal guides, and 404 share `@meltiply/ui/tokens.css`; static public
navigation reuses `@meltiply/ui/public.css`, and the product preview uses the same
neutral selected navigation as the workspace. Coarse pointers keep the shared 44px
minimum control height rather than phone-only variants.

`frontend/public/src/components/layout.astro` owns one static diagonal slash texture
for landing, guides, legal pages, and not-found. It derives a low-contrast stroke from
shared ink in either palette and paints only the page canvas: cards, previews,
controls, and navigation keep opaque surfaces. No overlay, pointer target, or motion;
it never applies to the signed-in workspace.

Landing and docs serve different jobs: product explanation and reading.
`DocumentationSearchTrigger` opens the canonical article-index dialog from both, and
is separate from workspace jump search. Its body portal is browser-only so static
generation renders the full page without touching `document`.

For each change: read the owner/caller, extend the canonical implementation, migrate
callers and guides, and exercise real states at desktop/phone widths in both palettes.
Verify focus, hover, busy, loading, empty, recoverable errors, selection, and nested
overflow. Compilation and lint are not visual proof; report only verification
actually exercised.

## Isolated pull-request UI previews

`frontend/app/src/preview` serves synthetic HTTP responses to the **same** application
routes, auth provider, queries, and shared controls. It is not a second demo UI, and
the build excludes this module graph from production.

Build with `bun run --filter frontend-app build:ui-preview`; output is
`frontend/app/dist/ui-preview`. Preview modules load dynamically only in that mode,
and MSW starts before router/session reads.

`frontend/app/preview-contract.ts` compiles the existing
[`openapi.yaml`](../packages/contracts/openapi.yaml) and
[`examples/operations.yaml`](../packages/contracts/examples/operations.yaml) into a
preview-only virtual module. Every documented operation registers automatically;
missing operation examples fail the build.

Workspace data comes from the same
[`seed.sql`](../scripts/cloudflare-local/postgres/seed.sql) as `bun run db:seed`.
`scripts/lib/preview-seed.ts` applies real migrations and seed in disposable
in-memory PGlite during the build, reuses the API's read projections, and emits only
public JSON. Seed changes appear on the next build without editing another dataset.
Seeded Asset metadata and attachment order are retained; media previews use a local
placeholder rather than fetching the seed's object keys.

The route picker is extracted structurally from the real `app-router.tsx` Route
declarations. UI previews count as development builds and expose the canonical
**DevBox** with the shared before-paint theme bootstrap. The dock uses `--z-devbox`;
body-portalled selects use `--z-devbox-overlay`. Expand its bottom-left pill and
choose **Preview** for scenario, operation, response, and route controls; **Apply
preview** reloads with shareable URL parameters, **Reset preview** clears them.
Scenario and operation identifiers are technical codes; control labels follow the
interface language.

| Scenario                                | Frontend state                                                  |
| --------------------------------------- | --------------------------------------------------------------- |
| `populated`, `success`                  | Seeded Workspace data with canonical transport outcomes         |
| `empty`                                 | Empty collections and zero aggregate counters                   |
| `loading`                               | Requests stay pending until canceled or reload                  |
| `validation-error`                      | Mutation validation failure; reads still populate forms         |
| `server-error`, `permission-denied`     | Data-request failures with session/workspace bootstrap retained |
| `signed-out`, `first-run`, `two-factor` | Sign-in, installation setup, authenticator challenge            |
| `viewer`, `editor`                      | Read-only or editorial permissions without Owner authority      |
| `publication-failed`, `channel-expired` | Publishing failures and Channel reconnection                    |

URL parameters are `previewScenario`, `previewOperation`, and `previewStatus`. Generic
saves, deletes, sign-in/out, and single-part uploads operate only in browser memory:
uploaded bytes become local Blob URLs, never R2 objects. No preview response sends
email, changes credentials, publishes content, or invokes background infrastructure.

`wrangler.ui-preview.jsonc` has no service, database, or storage bindings and rejects
API/telemetry requests reaching the server; browser handlers also reject unknown API
calls, and the CSP limits network access to its own origin. Never add production
secrets, an `API` binding, or a real backend origin.

For PR previews, create a separate Git-connected Worker `meltiply-ui-preview` with
the repository root as build root:

| Setting         | Value                                            |
| --------------- | ------------------------------------------------ |
| Build command   | `bun run --filter frontend-app build:ui-preview` |
| Deploy command  | `bun run --cwd frontend/app deploy:ui-preview`   |
| Preview command | `bun run --cwd frontend/app preview:ui-preview`  |
| Preview builds  | Enabled for PR branches you want to review       |

Do not configure `APP_URL` or production credentials. Preview URLs are public;
synthetic data holds no credentials or real records, so use Cloudflare Access if
unpublished UI is sensitive.
