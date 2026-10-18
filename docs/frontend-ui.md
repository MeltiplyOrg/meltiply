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

Remove replaced callers, aliases, local re-exports, duplicate wrappers, and unconsumed selectors during cutovers. Preserve feature behavior and the user-approved visual state during cleanup. Keep real API adapters distinct when endpoint contracts differ; deduplication is not a reason to invent a generic abstraction.

The interface has one implemented animation path. Existing animations remain; new animation work extends their shared owners. There is no motion provider, preference hook, mode state/props, root flag, stored motion setting, alternate-mode branch, or lint rule requiring those guards.

## Shared visual grammar

Use warm flat page/navigation fields, opaque content surfaces, the shared three-step ink ramp, and theme-independent geometry. Indigo/periwinkle identifies actions and focus; selected navigation is neutral. Semantic states have labels or accessible icons; platform colors identify providers rather than product state.

Geist is the working face; Geist Mono is for code, identifiers, and shortcuts. Interface glyphs use the canonical Lucide system; retain Meltiply's faceted mark and actual provider identity. Use named radius/elevation tokens and one intentional surface boundary, not duplicated borders/rings or a separate page palette.

## Navigation, search, and filters

`SidebarNav` and `NavigationShell` own the rail, header, mobile navigation, Settings/help/account access, and workspace context. `WORKSPACE_NAV_ITEMS` supplies supported destinations. Posts and Channels are single entries; view selection and Brand Profile scope belong to collections. Workspace identity is read-only.

`SidebarGlideHighlight` (`@meltiply/ui/sidebar-glide-highlight`) owns the rail's hover background: every `data-sidebar-item` row is a target, and one pill springs to the hovered row instead of rows painting their own hover fill. The Settings section rail reuses the same component with its own container and a tighter snap radius. Rows keep `relative z-10` so labels and the selected surface read above it, keyboard focus rings are unchanged, and the public docs rail reuses the same component with its nested Radix viewport.

`SlidingHighlight` (`@meltiply/ui/sliding-highlight`) owns every highlight that travels _between_ items: it measures the active item, writes that box as static geometry, and animates only transforms, so travel stays off the layout path. Menus drive it with `deferUntilInteraction` (`data-highlighted`, pointer and keyboard tracking, Radix pre-highlight suppressed); tab strips and segmented controls drive it from the selection itself (`data-state="active"`, `aria-pressed`). `axis="x"` adds translate plus `scaleX` from the left edge so a row of differently sized items — a segmented track, a `TabsList variant="segment"`, a `line` tab strip's accent underline — slides its fill or rule, settling back to `scaleX(1)` so the shape is crisp at rest; consumers style that indicator's vertical box (`inset-y-*` fill, `bottom-* h-*` underline) through `className`/`indicatorClassName`. One implementation covers the family: a control never paints its own selected fill next to the pill.

The footer uses one compact avatar/name account trigger with trailing chevrons, including an avatar-only collapsed state. Its account menu holds the actual name/email, Account settings, inline Light/Dark/System segments with matching icons, and Sign out. Theme changes apply immediately without dismissing the menu, using the same consent-aware owner as Settings; System follows live OS changes. Account settings reuses the existing route; signing out uses the shared session cleanup. Do not add demo profile, presence, or shortcut actions that Meltiply does not implement.

`WorkspaceSearch` is a jump palette over supported pages and loaded profiles, opened from the top bar or `hotkeys.commandMenu`. It is not a global Post index. Route toolbars own collection search and the current Brand Profile filter.

`TopToolbarFilters` owns the shared field-row disclosure: Where/and rows, Add filter chips, equality controls, per-row removal, Clear all, and active-value chips. Routes supply localized field metadata, real predicates, and reset callbacks. Empty added rows do not filter data. Removing/adding rows restores useful focus; nested portalled menus remain part of the disclosure.

Shared tooltips use the reference-derived compact inverse treatment and timing. Radix owns focus, Escape, collision, and portals. Keyboard hints supplement accessible names, never replace them.

`DropdownMenu` and `Select` render one menu vocabulary: the surface (`data-menu-surface`), rows (`[data-menu-item]`), right-aligned accent checks (`[data-menu-indicator]`), labels (`[data-menu-label]`), and separators (`[data-menu-separator]`) all come from `frontend/shared/motion.css`, so the account menu, row actions, filter panels, platform multi-select, and every listbox stay identical. `data-state` drives one shared entrance (`menu-surface-in`, 160ms settle) and exit (`menu-surface-out`, 120ms) for every surface; Radix writes that state, and a native disclosure sets it and stays mounted through the exit before closing. `SlidingHighlight` owns the hover pill inside a menu, exactly as `SidebarGlideHighlight` does in a rail (and in the Posts table view, where the same pill follows `[data-post-row]` instead of a row painting its own hover). Extend these wrappers instead of restyling a surface; a page-composed panel marks itself with the same `data-menu-surface` hook.

## Collections and selection

Posts orders **Table → Calendar → Grid**, with Table as default. All three share Post identity, owning Brand Profile, real outcomes, filtering, and supported actions. Table grouping/column visibility is presentation, not a different data model. Its rows open Details and have no trailing actions column; the row hover is the shared glide pill (`SidebarGlideHighlight`, `itemSelector="[data-post-row]"`), a grouped row stays mounted while its group is collapsed, and the group toggle animates that height transition in both directions rather than unmounting rows. Calendar Month/Week uses actual dates, day lists, overflow, and explicit compose entry that opens the composer drawer; it does not imply drag-rescheduling. Grid uses `PostCard` and real attachments; its column stepper morphs in (one WAAPI effect grows its box from nothing so the view switcher beside it is pushed over, and shrinks it again on the way out), and every count the workspace shows — the surface descriptions ("Showing {count} posts…", "{count} connected accounts…"), the stepper's column count, the section tabs' counts, a table group's size, a Post's channel and attachment totals, a profile card's connected accounts — is one `RollingCount`, whose one-line window clips so a change rolls the new value in from the side the count moved while the previous value leaves the other way.

Channels follows the Members directory composition: Accounts/Brand Profiles tabs, account search, status segments, field-row filters, identity table, and real profile cards. The section tabs' accent rule and the status segments' surface pill are each one travelling `SlidingHighlight`, so switching a section or a status slides the selection instead of repainting two controls. Connection cells contain one accessible health icon; recovery remains available without duplicate status text. Its background and controls match Posts.

`BulkSelectionBar` owns the inverse-ink floating pill, separators, count, action icon/label, and icon-only Deselect. Callers own selection, confirmation, and mutations. Select-all is visually checked only when the entire visible collection is selected. Partial selection stays unchecked while the pill reports the real count. Confirm a stable batch; remove successful targets and retain failures for retry.

## Settings and dialogs

`WorkspaceSettings` is a full route with Appearance, Language, Account, and Security. Every section shares the same background and bounded content column. Compact theme cards offer Light/Dark/System; System follows live OS palette changes. Current-page preferences work without optional storage; persistence follows the shared consent-aware owners. Account identity is read-only. Security controls are inline and retain password verification, authenticator enrollment, and recovery-code requirements.

| Task                        | Primitive           |
| --------------------------- | ------------------- |
| Focused form or jump search | `CenterDialog`      |
| Destructive confirmation    | `CenterAlertDialog` |
| Large Post inspection       | `SideDialog`        |

`SideDialog` owns the edge/phone drawer geometry, the compact record toolbar, its Close control, native body scrolling, opener restoration, and the optional body-class hook a pinned action bar needs. Features supply breadcrumb/context, supported header actions, and real content. Post inspection shows properties, caption, ordered attachments, and independent Channel outcomes; composing and editing a Post open the same drawer with the composer body, so no separate composer surface exists. It has no duplicated footer or reference-only task fields/comments.

The composer uses `ComposerSection` for titled sections and `DestinationSelector` for targeting. **Shared Content** leads the editor, followed by attached media and each selected Channel's named region containing caption overrides, attachment selection, and provider settings; no composer tabs hide these controls. Wide panels split into equal editor and destinations/publishing columns. The editor scrolls independently with its scrollbar hidden by the existing `hide-scrollbar` utility; shrinkable ancestors and non-shrinking sections preserve scrolling. Narrow panels stack in DOM order inside the drawer's native scrolling body. The pinned action bar carries the real save state and the single action resolved by the publishing mode. New compositions preserve a concrete Brand Profile choice or select the first available profile; reopening from aggregate scope adopts the Post's actual owner. The canonical `BrandProfileSelect` omits aggregate scope inside the composer. Every account owned by the selected profile uses the same `ChannelAvatar` owner as the Channels directory (`frontend/app/src/components/channels/channel-avatar.tsx`): an account photo when supplied, account initials when missing or failed, and a separate small provider badge. Account names, platform labels, and unavailable connection states remain visible. Eligible destinations start selected; explicit empty selection remains empty. The publishing selector uses `SegmentedControl fill`. The shared caption uses bounded `Textarea autoGrow`, shows used/maximum code-point characters from the tightest selected platform capability, and clamps new typing at that limit without truncating restored drafts. Unknown limits display an em dash with an unavailable explanation rather than an invented maximum; Channel overrides use their own platform limits.

Provider editor headings use the canonical `PlatformIcon`; account-name and provider tags are absent. Channel caption fields are always available, inherit shared content until first edited, and preserve intentional blanks independently of later shared edits. Only an active override exposes **Remove Custom Override** to restore live inheritance. `ChannelAvatar` owns an explicit flex positioning box so its small provider badge stays anchored to the account photo or initials.

Each Channel's attachment mode uses the canonical `Switch`: off persists a text-only target, on restores inheritance of all current/future Post attachments, and an explicit non-empty attachment subset keeps the switch on. Individual attachment choices remain available. `ProviderPanel` supplies an inline-size container so all six TikTok interaction/disclosure switches share one flat grid: two columns when the panel has room, one on narrow panels, with full-row labels and unchanged creator-availability gates. Provider capability metadata keeps the adapters' canonical caption ceilings even when credentials/live acceptance are absent; publish/connect flags remain false, and the composer does not invent a fallback limit.

`ScheduleDateTime` (`frontend/app/src/components/composer/schedule-date-time.tsx`) owns the composer's compact date disclosure, Monday-first calendar, and exact 24-hour hour/minute selectors. It composes canonical `Button`/`Select` controls and the Posts local-date formatter, without a native date popup, new dialog, or dependency. Browsing does not commit a date; choosing one preserves time, and changing time preserves the local date. The browser's time zone stays visible. Calendar arrows, Home/End, Page Up/Down (Shift for years), Enter/Space, and Escape retain roving focus and return focus to the date button after selection or dismissal. The composer still owns seed/hydration/recovery, local-to-ISO conversion, and submit validation.

Primitives own accessible names, focus trapping, Escape/dismissal, scroll lock, and transitions. Preserve stable content through exits with `useLatchedValue` where needed; clear secrets according to the security lifecycle. Features compose a dialog rather than implementing another frame.

Use `@meltiply/ui/toast` and `@meltiply/ui/sileo` for transient outcomes, with the affected object and useful recovery. Clipboard feedback includes the copied value. Keep inline validation and durable failures beside their controls/records. Accepted delivery is not published success.

Copy resolves through `useI18n`: `t` for messages that interpolate values, and `<Trans>` for a message whose placeholder carries a component — a `RollingCount` inside `"{count} accounts"`, for instance — instead of assembling a sentence from translated fragments. Both translate the same way, including the dev-only pseudo-localization of literal text.

## Public surfaces and verification

Landing and docs share palette/fonts but serve different jobs: product explanation and reading. `DocumentationSearchTrigger` opens the canonical article-index dialog from both landing and documentation preferences; it is separate from workspace jump search. Public scrolling/navigation adapters release state during Astro swaps. Native links, keyboard navigation, fragments, and accessibility behavior remain usable.

For each change: read the owner/caller, extend the canonical implementation, migrate callers and guides, and exercise actual states at desktop/phone widths in both palettes. Verify focus, hover, busy, loading, empty, recoverable errors, selection, and nested overflow. Follow the repository's hosted completion gate. Compilation and lint are not visual proof; report only verification actually exercised.
