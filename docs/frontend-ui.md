# Shared UI ownership and reuse

Meltiply's current interface adapts [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio) to publishing. The inspected reference is `904205c626918ee96054eb35495c394a60c0c601`. Source reuse was authorized for this redesign; public availability is not a general-purpose license grant.

Use [product UI intent](../PRODUCT.md#modular-consistent-surfaces) for behavior, [the visual system](../DESIGN.md) for reusable design rules, [layout](frontend-layout.md) for geometry/scroll boundaries, and the [capability inventory](frontend-capabilities.md) for shipped workflows. Components and [`tokens.css`](../frontend/shared/tokens.css) are implementation truth; reference demo features are not product requirements.

## Canonical owners

| Responsibility                                                | Owner                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Palette, self-hosted Geist fonts, density, radius, elevation  | `frontend/shared/tokens.css` and shared CSS entrypoints                       |
| Buttons, fields, menus, tabs, tables, dialogs, feedback       | `frontend/shared/src/components/ui`                                           |
| Shared status, navigation, and selection atoms                | `frontend/shared/src/components/atoms` and `primitives`                       |
| Static Astro controls and the faceted brand mark              | `frontend/shared/src/components/public`                                       |
| Icon sizing/hover/animation loop                              | `frontend/shared/animated-icons/icon-motion-frame.tsx` and `use-icon-loop.ts` |
| Theme, consent, clipboard, toast store, animation recipes     | Existing modules in `frontend/shared`                                         |
| Navigation, workspace jump search, Settings, collection state | `frontend/app/src/components` and owning context/hooks                        |
| Loading placeholders and the boot frame                       | `frontend/app/src/components/layout/workspace-loading-skeleton.tsx`           |
| Document and nested-container smooth scrolling                | `frontend/app/src/components/layout/smooth-scroll.tsx`                        |
| Sidebar/Settings sign-out behavior                            | `frontend/app/src/hooks/use-workspace-sign-out.ts`                            |
| Public article search trigger/dialog                          | `frontend/public/src/components/search.tsx`                                   |
| Documentation tree, reading navigation, public content        | `frontend/public/src/components` and `content/docs`                           |

Read [`@meltiply/ui` exports](../frontend/shared/package.json), the implementation, and a real caller before changing a control. Use explicit subpaths such as `@meltiply/ui/button` or `@meltiply/ui/table`. Shared modules do not import app internals; feature owners supply authorized data, labels, pending state, and actions.

## TypeScript, React, and styling

Rewritten app components use strict TypeScript/TSX, React, Tailwind utilities, semantic tokens, and `cn`. Extend a canonical variant or compose a page from existing primitives. Keep finite style maps outside render functions. Shared CSS owns global reset/focus, tokens, and browser interoperability; public Astro/Fumadocs adapters use the same tokens within their framework.

Canonical `Button`, `Input`, `Textarea`, `SelectTrigger`, and menu-row styles adapt to coarse pointers rather than guessing input type from screen width. Buttons/selects/menu rows have 44px minimum heights; text inputs and textareas retain 16px text. The shared safe-area tokens supply shell/drawer insets without page-specific spacing values.

Remove replaced callers, aliases, local re-exports, duplicate wrappers, and unconsumed selectors during cutovers. Preserve feature behavior and the user-approved visual state during cleanup. Keep real API adapters distinct when endpoint contracts differ; deduplication is not a reason to invent a generic abstraction.

The interface has one implemented animation path. Existing animations remain; new animation work extends their shared owners. There is no motion provider, preference hook, mode state/props, root flag, stored motion setting, alternate-mode branch, or lint rule requiring those guards.

Native OS reduced motion remains an accessibility contract: shared WAAPI effects skip spatial travel when `prefers-reduced-motion: reduce` is active, independently of the absence of an application motion mode.

## Shared visual grammar

Use warm flat page/navigation fields, opaque content surfaces, the shared three-step ink ramp, and theme-independent geometry. Indigo/periwinkle identifies actions and focus; selected navigation is neutral. Semantic states have labels or accessible icons; platform colors identify providers rather than product state.

Geist is the working face; Geist Mono is for code, identifiers, and shortcuts. Interface glyphs use the canonical Lucide system; retain Meltiply's faceted mark and actual provider identity. Use named radius/elevation tokens and one intentional surface boundary, not duplicated borders/rings or a separate page palette.

## Navigation, search, and filters

`SidebarNav`, `MobileNavigationSidebar`, and `NavigationShell` own the rail, header, mobile navigation layer, Settings/help/account access, and workspace context. `WORKSPACE_NAV_ITEMS` supplies supported destinations in Posts → Analytics → Channels → Queues order. Each destination has one entry; view selection and Brand Profile scope belong to collections. Workspace identity is read-only.

The phone navigation panel is `MobileNavigationSidebar`: the same `SidebarNav` as the desktop rail, positioned as a fixed left-edge layer over the workspace with a fading scrim, sliding in from the left. It renders `collapsible={false}` instead of a reduced copy of its destinations. The same help link, identity, Account settings, palette choices, and sign-out actions remain available.

The sidebar composes `CenterDialog` and `NavigationDialogContent` from the shared
`@meltiply/ui/center-dialog` owner. Radix owns focus looping and nested-menu
Escape arbitration; there is no feature-local document listener or focus trap.
The shell's background `inert` state is separate from containment.

`SidebarGlideHighlight` (`@meltiply/ui/sidebar-glide-highlight`) owns the rail's hover background: every `data-sidebar-item` row is a target, and one pill springs to the hovered row instead of rows painting their own hover fill. The Settings section rail reuses the same component with its own container and a tighter snap radius. Rows keep `relative z-10` so labels and the selected surface read above it, keyboard focus rings are unchanged, and the public docs rail reuses the same component with its nested Radix viewport.

`SlidingHighlight` (`@meltiply/ui/sliding-highlight`) owns every highlight that travels _between_ items: it measures the active item, writes that box as static geometry, and animates only transforms, so travel stays off the layout path. Menus drive it with `deferUntilInteraction` (`data-highlighted`, pointer and keyboard tracking, Radix pre-highlight suppressed); tab strips and segmented controls drive it from the selection itself (`data-state="active"`, `aria-pressed`). `axis="x"` adds translate plus `scaleX` from the left edge so a row of differently sized items — a segmented track, a `TabsList variant="segment"`, a `line` tab strip's accent underline — slides its fill or rule, settling back to `scaleX(1)` so the shape is crisp at rest; consumers style that indicator's vertical box (`inset-y-*` fill, `bottom-* h-*` underline) through `className`/`indicatorClassName`. One implementation covers the family: a control never paints its own selected fill next to the pill.

The footer uses one compact avatar/name account trigger with trailing chevrons, including an avatar-only collapsed state. Its account menu holds the actual name/email, Account settings, inline Light/Dark/System segments with matching icons, and Sign out. Theme changes apply immediately without dismissing the menu, using the same consent-aware owner as Settings; System follows live OS changes. Account settings reuses the existing route; signing out uses the shared session cleanup. Do not add demo profile, presence, or shortcut actions that Meltiply does not implement.

`WorkspaceSearch` is a jump palette over supported pages and loaded profiles, opened from the top bar or `hotkeys.commandMenu`. It is not a global Post index. Route toolbars own collection search and the current Brand Profile filter.

`TopToolbarFilters` owns the shared field-row disclosure: Where/and rows, Add filter chips, equality controls, per-row removal, Clear all, and active-value chips. Routes supply localized field metadata, real predicates, and reset callbacks. Empty added rows do not filter data. Removing/adding rows restores useful focus; nested portalled menus remain part of the disclosure.

Shared tooltips use the reference-derived compact inverse treatment and timing. Radix owns focus, Escape, collision, and portals. Keyboard hints supplement accessible names, never replace them.

`DropdownMenu` and `Select` render one menu vocabulary: the surface (`data-menu-surface`), rows (`[data-menu-item]`), right-aligned accent checks (`[data-menu-indicator]`), labels (`[data-menu-label]`), and separators (`[data-menu-separator]`) all come from `frontend/shared/motion.css`, so the account menu, row actions, filter panels, platform multi-select, and every listbox stay identical. An anchored surface inherits the trigger box as a minimum width (`data-menu-fit-trigger` reads Radix's `--radix-*-trigger-width`), so a list under a full-width filter or field control spans that control while icon-triggered action menus keep the shared 200px floor. `data-state` drives one shared entrance (`menu-surface-in`, 160ms settle) and exit (`menu-surface-out`, 120ms) for every surface; Radix writes that state, and a native disclosure sets it and stays mounted through the exit before closing. `SlidingHighlight` owns the hover pill inside a menu, exactly as `SidebarGlideHighlight` does in a rail. Posts rows use the table's own shared hover fill, not a glide pill. Extend these wrappers instead of restyling a surface; a page-composed panel marks itself with the same `data-menu-surface` hook.

## Collections and selection

Posts orders **Table → Calendar → Grid**, with Table as default. All three share Post identity, owning Brand Profile, real outcomes, filtering, and supported actions. Table grouping/column visibility is presentation, not a different data model. Its rows open Details and have no trailing actions column; rows use the table's own shared hover fill, a grouped row stays mounted while its group is collapsed, and the group toggle animates that height transition in both directions rather than unmounting rows. Calendar Month/Week uses actual dates, day lists, overflow, and explicit compose entry that opens the composer drawer; it does not imply drag-rescheduling. Grid uses `PostCard` and real attachments; its column stepper morphs in (one WAAPI effect grows its box from nothing so the view switcher beside it is pushed over, and shrinks it again on the way out), and every count the workspace shows — the surface descriptions ("Showing {count} posts…", "{count} connected accounts…"), the stepper's column count, the section tabs' counts, a Post's channel and attachment totals, a table group's size, a profile card's connected accounts — is one `RollingCount`, whose one-line window clips so a change rolls the new value in from the side the count moved while the previous value leaves the other way.

Posts Table and its Columns menu share `postAnalyticsColumns`: Likes, Cmts, Shrs, Saves, Clicks, Views, Impr., and Reach. The existing spreadsheet Table retains horizontal scrolling, including on phones, and full metric names label abbreviated headers accessibly. `Post.analytics` carries one batched sum of each published Channel's latest stored snapshot, not the sum of historical snapshots or a request per row. Real zeros render as zero; drafts, non-published Posts, absent snapshots, and null/untracked counters render `-`. Saves/Clicks currently stay null. Refresh follows the normal Post query lifecycle rather than pretending measurements are live or audience-deduplicated.

`usePosts` owns an infinite-query cache of 60-record server pages. Grid slices the filtered loaded collection into pages; Table appends explicitly requested pages. Both reuse the same browser-memory cache across view/route navigation, retain inactive pages for 30 minutes, and share the existing mutation invalidation and active-publication polling. Cached content is not written to persistent browser storage and is discarded with the user/workspace query-provider boundary. A failed next-page read leaves loaded records and selection intact and exposes retry through the same bottom control.

`usePlatformCapabilities` retains its one successful deployment-defined result for
the lifetime of the current identity/Workspace-scoped QueryClient (`staleTime` and
`gcTime` are infinite for this query only). Navigation, focus, reconnect, and Channel
disconnects do not refetch it. Sign-out, scope replacement, and a full application
reload create fresh query state. Nothing is persisted to browser storage. General
60-second freshness, dynamic publishing requirements, polling, and Asset preview
URL policies are unchanged.

The empty Table message and Create post action belong to the visible viewport outside the wide table body, so they do not disappear offscreen with analytics columns. Calendar navigation is outside its independently scrolling date canvas; horizontal or vertical calendar movement cannot carry Today, period navigation, or Month/Week away.

Queues extends `PostCalendarGridView` rather than introducing a second month grid
or period toolbar. `CalendarTimeGrid` owns hourly Week geometry and current-time
paint; `QueueCalendar` owns Queue timezone, bounded fully paged reads, its live
clock, upcoming assignment selection and focused reservation actions. `post-row.ts`
projects real Post/Channel data for both routes, including frozen Provider content.
The existing shared Button, SegmentedControl, Tooltip and centered dialog owners
retain focus, selection, animation and destructive confirmation behavior.
Desktop Queue navigation uses neutral shared Buttons and `SidebarGlideHighlight`;
phones use a compact Select, with the same administrator actions in DropdownMenu.
The Week canvas initially reveals today and keeps its time axis visible during
horizontal swipes. Phone Month fits all seven dates and uses assignment counts
instead of unreadably narrow Post chips; selecting a date/count opens its Week.

`QueueTimezonePicker` owns Queue timezone selection: the finite browser IANA
catalog plus `UTC` and the saved alias, ranked by substring then ordered
character gaps, so `ktm` finds Asia/Katmandu and `yk` finds Reykjavik or Yakutsk.
The panel renders **inline** under its trigger, not in a portal: a portalled list
inside a modal dialog has its wheel events cancelled by the dialog's scroll lock
and cannot scroll. It composes the shared menu surface, Input, Button and React
Aria's keyboard listbox, holds a fixed 240px list that scrolls inside the dialog,
and centers the saved zone when it opens. Search never commits (Enter in the
search field must not submit the Queue form), choosing an identifier closes the
panel, and Escape belongs to the panel while it is open — the dialog declines the
same keypress so one layer closes at a time.

Week chips paint over the hourly canvas, so they use the opaque
`--accent-tint-solid`/`--green-tint-solid`/`--red-tint-solid` twins rather than the
translucent tints; otherwise the hour rules show through the chip.

The Queue editor bounds its Weekly slots list (`max-h-72`, its own scroll) so a
plan with many slots scrolls inside the dialog instead of stretching it; `Add
slot` sits below the scroller and stays reachable.

`calendarSlots` projects the validated weekly plan onto the visible civil days
for display only, applying the allocator's rules: nonexistent DST occurrences are
skipped and repeated hours use the later instant. An exact-instant membership
renders a **filled** slot using the real Post chip; every other projected
occurrence renders a dashed **open** slot, muted once elapsed. Off-plan immutable
reservations remain ordinary Post chips rather than being folded into a slot. The
projection is bounded by the visible window (at most 42 days) and the plan's
slots; it never allocates, moves, or mutates work. Month interleaves slots and
off-plan Posts in time order and summarizes filled/unfilled counts; the first
three chips are the earliest entries. Date buttons include those counts in their
accessible names whenever the loaded Month summary is shown. Week places both
on the hourly canvas.

The red current-time rule is painted only inside today's column, with its clock
label anchored there, and never spans the week or other dates. Month↔Week changes
commit through `transitionViewEffect` (native View Transitions): only the seven
date labels that survive into Week keep a `view-transition-name`, they morph while
the rest of the calendar crossfades, the toolbar stays still, and unsupported
browsers or native reduced motion commit immediately.
Repeated choices skip the previous transition without skipping its state commit.
The Queue page body never installs a second smooth-scroll controller on phones;
only the calendar viewport owns it.

Post deletion soft-deletes composition and stops only pending delivery; it does not delete platform copies or retained publication history. Both Post and Calendar collection reads exclude soft-deleted Posts, so view switching and reloads cannot reconstruct them from retained Distributions.

Channels follows the Members directory composition: Accounts/Brand Profiles tabs, account search, status segments, field-row filters, identity table, and real profile cards. The section tabs' accent rule and the status segments' surface pill are each one travelling `SlidingHighlight`, so switching a section or a status slides the selection instead of repainting two controls. Connection cells contain one accessible health icon; recovery remains available without duplicate status text. Its background and controls match Posts.

Channel identity uses a saved-name line followed by one compact metadata line
containing the available username and provider ID. `ChannelCopyValues` composes
shared link-style `Button` controls: the values themselves copy their raw text,
without separate icon buttons, through the existing clipboard helper and
success/error toast. Values truncate without wrapping, so detecting a username
does not add another row or change directory density. Keyboard focus and the
shared coarse-pointer targets remain intact.

Connection cards stack platform identity above saved-account status and connection actions on phones. The connection dialog uses one outer native scroller at narrow widths; its platform list gets its own bounded scroller only when the panel has room.

`BulkSelectionBar` owns the inverse-ink floating pill, separators, count, action icon/label, and icon-only Deselect. Callers own selection, confirmation, and mutations. Select-all is visually checked only when the entire visible collection is selected. Partial selection stays unchecked while the pill reports the real count. Confirm a stable batch; remove successful targets and retain failures for retry.

## Settings and dialogs

`WorkspaceSettings` is a full route with Appearance, Language, Account, Security, and — for administrators — Administration. Every section shares the same background; the preference and security sections use the bounded form column while Administration follows the directory composition. Compact theme cards offer Light/Dark/System; System follows live OS palette changes. Current-page preferences work without optional storage; persistence follows the shared consent-aware owners. Account identity is read-only. Security controls are inline and retain password verification, authenticator enrollment, and recovery-code requirements. Administration reuses the shared spreadsheet `Table` (grid columns) for members and invitations; rows carry a lifecycle `Switch`, the Installation Owner wears a crown tooltip, and row actions sit behind a three-dot menu. Workspace is a label/value settings form with compact seat counts, not a table. `AuditLogTable` owns the filtered, paginated log and defers filtering and paging to the route's query; its search and filter controls keep fixed widths so selecting a value cannot reflow the toolbar, and Refresh re-reads the current page. The Administration surface is height-locked to the content pane so only the lists scroll, and the tab strip is content-width rather than stretched across the surface.

| Task                        | Primitive                                  |
| --------------------------- | ------------------------------------------ |
| Focused form or jump search | `CenterDialog`                             |
| Destructive confirmation    | `CenterAlertDialog`                        |
| Large Post inspection       | `SideDialog`                               |
| Modal phone navigation      | `CenterDialog` + `NavigationDialogContent` |

`SideDialog` owns the edge/phone drawer geometry, the compact record toolbar, its Close control, native body scrolling, opener restoration, and the optional body-class hook a pinned action bar needs. Features supply breadcrumb/context, supported header actions, and real content. Post inspection shows properties, caption, ordered attachments, the Post's stored analytics once at least one Channel has published — totals plus separate Engagement over time and Reach & impressions over time line charts — and independent Channel outcomes; composing and editing a Post open the same drawer with the composer body, so no separate composer surface exists. The charts load lazily and read chronological stored snapshots, carrying each Channel's latest measured counters forward rather than summing historical snapshots. The first 500 measurements per Channel are shown with an explicit notice when that limit is reached. It has no duplicated footer or reference-only task fields/comments.

The Post inspector's Reach & impressions over time chart includes a third, separately styled Views line. All three series use the same latest-per-Channel snapshot aggregation and expose exact values in the tooltip and accessible table; media views remain available when Reach or Impressions are untracked.

`NavigationDialogContent` extends the shared Radix dialog owner for the left-edge
phone rail: it owns modal focus, nested Escape arbitration, scrim/Close dismissal,
opener restoration without scrolling, and the 300ms panel/scrim motion in shared
`motion.css`. `MobileNavigationSidebar` supplies the existing `SidebarNav`, labels,
destinations and desktop-breakpoint closure. It does not reimplement keyboard or
focus handling, and the non-modal Post inspection `SideDialog` remains unchanged.

The shared `FilterChecklist` in `@meltiply/ui/dropdown-menu` owns checkbox toggling, optional aggregate clearing, stay-open selection, and Radix keyboard/dismissal behavior. Posts status and `BrandProfileFilterSelect` use it alongside the canonical platform filter. Composition reuses `BrandProfileFilterSelect` without an aggregate row: empty means no selected profiles. `BrandProfileSelect` remains single-value for Channels scope; both modes share one resolved/unknown option roster. Inspector focus restoration uses `preventScroll` rather than scrolling the live collection back to its opener.

`PostsDrawer` keeps an interrupted composition mounted in a hidden, inert section while inspection takes presentation priority. Closing inspection or choosing the drawer's New Post control resumes that live composition, including uploads, without functional-storage consent. Explicit composition dismissal releases it after the exit. Editing/scheduling dependencies load lazily under a drawer-local Suspense fallback; browsing does not import them eagerly. Composer URL intent synchronizes in both directions on navigation and history changes.

The composer uses `ComposerSection` for titled sections and `DestinationSelector` for targeting. **Shared Content** leads the editor, followed by attached media and each selected Channel's named region containing caption overrides, attachment selection, and provider settings; no composer tabs hide these controls. Wide panels give destinations/publishing a 340px column and the editor the remaining width. The editor scrolls independently with its scrollbar hidden by the existing `hide-scrollbar` utility; shrinkable ancestors and non-shrinking sections preserve scrolling. Narrow panels stack in DOM order inside the drawer's native scrolling body. The pinned action bar carries the real save state and the single action resolved by the publishing mode. Once per mounted composer session, initialization preserves a concrete Brand Profile choice or selects the first available profile; reopening from aggregate scope waits for the Post and adopts its actual owner. Later aggregate selections remain unchanged. That owner is composer-local: opening the composer never writes the collection's Brand Profile selection, so the Posts list and its filter stay exactly as the creator left them behind the drawer. Composer-initiated navigation — **Manage Queues** and **Add Channel** — asks for an explicit save-draft, discard, or keep-editing decision when unsaved changes could not be restored after leaving (no functional-storage consent); with consent, the recovery record restores the composition when the composer reopens.

`DestinationSelector` keeps composition profile selection local, groups accounts by provider, and identifies each account's owning profile. Selecting profiles never changes the composition's anchor/identity or discards its inputs. `profile-copies.ts` coordinates existing Post and upload mutations: one stable Post and separately owned media per selected profile, target attachment remapping, all-drafts-before-scheduling, per-profile progress, and unchanged-intent retry without rescheduling completed copies. Browser recovery validates and retains these identities only with functional consent. A single anchor profile preserves the existing single-Post path.

A mounted composition keeps one async identity even after its first save. Subsequent single-Post edits recover under the saved Post id, so reopening that record restores unsaved work. A new multi-profile batch keeps its copy identities together under the new-composition key; learning an anchor copy id never moves partial progress into a different namespace.

Original-media reads use the canonical `lib/api.ts` binary adapter: a signed object-store download never receives API bearer headers or session cookies. Failed copy uploads release their sessions. A new draft write invalidates the previous accepted delivery marker because saving cancels pending deliveries; only an unchanged retry can skip a completed profile. Readiness follows each Channel's selected attachments, so unused media does not block a text-only delivery. Readiness reads and polling have a shared five-minute deadline per profile; expiry reports a failure and retains the saved copy for retry.
Recovered original-media copies reconstruct a valid filename extension from the canonical domain MIME policy; a display title is not treated as an upload filename. The copy keeps that title and the original bytes, without weakening upload validation.

Every account uses the same `ChannelAvatar` owner as the Channels directory (`frontend/app/src/components/channels/channel-avatar.tsx`): an account photo when supplied, account initials when missing or failed, and a separate small provider badge. Account names, platform labels, and unavailable connection states remain visible. Eligible destinations start selected; explicit empty selection remains empty. The publishing selector uses `SegmentedControl fill`. The shared caption uses bounded `Textarea autoGrow`, shows used/maximum code-point characters from the tightest selected platform capability, and clamps new typing at that limit without truncating restored drafts. Unknown limits display an em dash with an unavailable explanation rather than an invented maximum; Channel overrides use their own platform limits.

Queue mode uses that same selector and the canonical Select for a named plan; feature-owned queries enforce one owning Brand Profile. The Queues route composes `WorkspaceSurface`, `CenterDialog`, `CenterAlertDialog`, Input, Select, and Button rather than adding another control family. Its editor owns configuration and stable slot-row identities; the feature owns roles, tenant scope, pagination, async outcomes, and confirmations. Configuration writes stay open on validation errors and refuse dismissal while pending. Membership inspection keeps immutable assigned instants and Channel statuses separate from configuration.

Provider editor headings use the canonical `PlatformIcon`; account-name and provider tags are absent. Channel caption fields are always available, inherit shared content until first edited, and preserve intentional blanks independently of later shared edits. Only an active override exposes **Remove Custom Override** to restore live inheritance. `ChannelAvatar` owns an explicit flex positioning box so its small provider badge stays anchored to the account photo or initials. Its `card` size supplies a compact 48px rounded-square portrait for destination cards; the directory retains the compact circular default.

Destination cards use 8px padding and gaps, with the display name and platform sharing the first line. Separate **Username: @handle** and **ID: provider-assigned identifier** lines follow, including for unavailable accounts. `ChannelIntegration.username` preserves the contract's optional `username`, and `platformUserId` preserves `platform_user_id`; Meltiply's internal account id remains the selection key. The existing `formatUsername` helper adds only the display @ prefix. Missing/blank usernames explicitly say **Username not provided** and are never inferred from a display name or either id. Both identity values wrap within the card so the full values remain readable on phones.

Each Channel's attachment mode uses the canonical `Switch`: off persists a text-only target, on restores inheritance of all current/future Post attachments, and an explicit non-empty attachment subset keeps the switch on. Individual attachment choices remain available. `ProviderPanel` supplies an inline-size container so all six TikTok interaction/disclosure switches share one flat grid: two columns when the panel has room, one on narrow panels, with full-row labels and unchanged creator-availability gates. Provider capability metadata keeps the adapters' canonical caption ceilings even when credentials/live acceptance are absent; publish/connect flags remain false, and the composer does not invent a fallback limit.

`ScheduleDateTime` (`frontend/app/src/components/composer/schedule-date-time.tsx`) shows a compact date button beside `TimeOfDayField` (`frontend/app/src/components/posts/time-of-day-field.tsx`), with the browser's time zone underneath. The same publishing-feature wall-time editor serves recurring Queue slots; it accepts complete `HH:mm` values without converting timezones and composes React Aria segments with the canonical Input, Popover and Select owners. Disabled slots disable both segmented editing and chooser controls. The date button opens a 280px Radix popover containing React DayPicker; coarse pointers get a 328px panel and 44px day targets. The calendar uses only the weeks its month needs. Canonical `Button`/`buttonVariants` and `Input`/`inputVariants` own control styling; the popover reuses the shared menu surface and motion hooks. Keep the popover's Radix release aligned with the drawer's dismissal/focus primitives so Escape closes only the top layer. Libraries own calendar geometry, localization, focus, and hour/minute typing and arrow-key editing. Selecting a date closes the popover and returns focus to its button. Browsing does not commit a date; choosing one preserves time, and changing time preserves the local date. The composer still owns seed/hydration/recovery, local-to-ISO conversion, and submit validation.

`@meltiply/ui/popover` owns anchored, non-menu form panels, including both scheduler pickers. It portals Radix content with the shared surface/motion hooks, a 6px offset, and 16px collision padding; feature callers own labels, dimensions, and form state rather than importing Radix directly.

Date and time share one compact row inside the publishing column, without a permanently expanded calendar or browser-native clock popup. Clicking the time field's background focuses hours so a complete `HH:mm` can be typed; clicking the hour or minute edits that segment. The clock is an actual **Choose time** button, opening a compact popover with canonical `Select` controls for all 24 hours and all 60 minutes. Choices apply immediately without moving the local date; **Done** or Escape closes the chooser and restores its button. Exact minutes remain available rather than restricting schedules to preset slots. Composer media columns likewise follow the panel, not the viewport; touch devices retain visible media actions even at tablet widths. The pinned action bar wraps its save explanation above a full-width action on narrow panels and clears the home indicator.

Primitives own accessible names, focus trapping, Escape/dismissal, scroll lock, and transitions. Preserve stable content through exits with `useLatchedValue` where needed; clear secrets according to the security lifecycle. Features compose a dialog rather than implementing another frame.

Inline Security uses the router's navigation blocker while a request is busy or enrollment/recovery codes await completion. Section changes, route changes, and browser history cannot discard that state; verification or explicit server-side cancellation must finish first. Document departures show the browser's unload warning. An allowed departure clears local secrets by unmounting the section.

Use `@meltiply/ui/toast` and `@meltiply/ui/sileo` for transient outcomes, with the affected object and useful recovery. Clipboard feedback includes the copied value. Keep inline validation and durable failures beside their controls/records. Accepted delivery is not published success.

Copy resolves through `useI18n`: `t` for messages that interpolate values, and `<Trans>` for a message whose placeholder carries a component — a `RollingCount` inside `"{count} accounts"`, for instance — instead of assembling a sentence from translated fragments. Both translate the same way, including the dev-only pseudo-localization of literal text.

## Public surfaces and verification

Landing, docs, legal guides, and the 404 page share `@meltiply/ui/tokens.css`: warm neutral surfaces, theme-aware action/ink roles, Geist fonts, and named chip/control/card/window radii. Static public navigation and action links reuse `@meltiply/ui/public.css`; the product preview uses the same neutral selected navigation as the workspace. Compact controls keep the shared 44px minimum height on coarse pointers rather than adding phone-only button variants.

The public document frame (`frontend/public/src/components/layout.astro`) owns one static diagonal slash texture for landing, guides, legal pages, and not-found states. It derives its low-contrast stroke from shared ink in either palette and paints only the page canvas: article cards, product previews, controls, and navigation retain their opaque surfaces. The texture adds no overlay, pointer target, or motion, and does not apply to the signed-in workspace.

Landing and docs serve different jobs: product explanation and reading. `DocumentationSearchTrigger` opens the canonical article-index dialog from both landing and documentation preferences; it is separate from workspace jump search. Its body portal is browser-only so static generation renders the full page without accessing `document`; browser dismissal retains the existing exit and opener-focus lifecycle. Public scrolling/navigation adapters release state during Astro swaps. Native links, keyboard navigation, fragments, and accessibility behavior remain usable.

For each change: read the owner/caller, extend the canonical implementation, migrate callers and guides, and exercise actual states at desktop/phone widths in both palettes. Verify focus, hover, busy, loading, empty, recoverable errors, selection, and nested overflow. Follow the repository's hosted completion gate. Compilation and lint are not visual proof; report only verification actually exercised.
