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

`SlidingHighlight` (`@meltiply/ui/sliding-highlight`) owns every highlight that travels *between* items: it measures the active item, writes that box as static geometry, and animates only transforms, so travel stays off the layout path. Menus drive it with `deferUntilInteraction` (`data-highlighted`, pointer and keyboard tracking, Radix pre-highlight suppressed); tab strips and segmented controls drive it from the selection itself (`data-state="active"`, `aria-pressed`). `axis="x"` adds translate plus `scaleX` from the left edge so a row of differently sized items — a segmented track, a `TabsList variant="segment"`, a `line` tab strip's accent underline — slides its fill or rule, settling back to `scaleX(1)` so the shape is crisp at rest; consumers style that indicator's vertical box (`inset-y-*` fill, `bottom-* h-*` underline) through `className`/`indicatorClassName`. One implementation covers the family: a control never paints its own selected fill next to the pill.

The footer uses one compact avatar/name account trigger with trailing chevrons, including an avatar-only collapsed state. Its account menu holds the actual name/email, Account settings, inline Light/Dark/System segments with matching icons, and Sign out. Theme changes apply immediately without dismissing the menu, using the same consent-aware owner as Settings; System follows live OS changes. Account settings reuses the existing route; signing out uses the shared session cleanup. Do not add demo profile, presence, or shortcut actions that Meltiply does not implement.

`WorkspaceSearch` is a jump palette over supported pages and loaded profiles, opened from the top bar or `hotkeys.commandMenu`. It is not a global Post index. Route toolbars own collection search and the current Brand Profile filter.

`TopToolbarFilters` owns the shared field-row disclosure: Where/and rows, Add filter chips, equality controls, per-row removal, Clear all, and active-value chips. Routes supply localized field metadata, real predicates, and reset callbacks. Empty added rows do not filter data. Removing/adding rows restores useful focus; nested portalled menus remain part of the disclosure.

Shared tooltips use the reference-derived compact inverse treatment and timing. Radix owns focus, Escape, collision, and portals. Keyboard hints supplement accessible names, never replace them.

`DropdownMenu` and `Select` render one menu vocabulary: the surface (`data-menu-surface`), rows (`[data-menu-item]`), right-aligned accent checks (`[data-menu-indicator]`), labels (`[data-menu-label]`), and separators (`[data-menu-separator]`) all come from `frontend/shared/motion.css`, so the account menu, row actions, filter panels, platform multi-select, and every listbox stay identical. `data-state` drives one shared entrance (`menu-surface-in`, 160ms settle) and exit (`menu-surface-out`, 120ms) for every surface; Radix writes that state, and a native disclosure sets it and stays mounted through the exit before closing. `SlidingHighlight` owns the hover pill inside a menu, exactly as `SidebarGlideHighlight` does in a rail (and in the Posts table view, where the same pill follows `[data-post-row]` instead of a row painting its own hover). Extend these wrappers instead of restyling a surface; a page-composed panel marks itself with the same `data-menu-surface` hook.

## Collections and selection

Posts orders **Table → Calendar → Grid**, with Table as default. All three share Post identity, owning Brand Profile, real outcomes, filtering, and supported actions. Table grouping/column visibility is presentation, not a different data model. Its rows open Details and have no trailing actions column; the row hover is the shared glide pill (`SidebarGlideHighlight`, `itemSelector="[data-post-row]"`), a grouped row stays mounted while its group is collapsed, and the group toggle animates that height transition in both directions rather than unmounting rows. Calendar Month/Week uses actual dates, day lists, overflow, and explicit compose entry that opens the composer drawer; it does not imply drag-rescheduling. Grid uses `PostCard` and real attachments.

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

The composer body reads as one column of sections — `ComposerSection` supplies the shared section header, `DestinationSelector` supplies the destinations block with the same header shape — with the compose column beside a fixed-width destinations/publishing rail once the _panel_ (not the viewport) is wide enough, and a pinned action bar that carries the draft's real save state and the single action the selected publishing mode resolves. Destination chips are selectable only while one Brand Profile owns the composition: the aggregate "All Brand Profiles" view lists the accounts as unavailable with the reason, because a selection nothing can publish to must not look like a choice. Composing requires an owning Brand Profile, and the panel says so in place instead of pointing at a control that no longer lives there.

Primitives own accessible names, focus trapping, Escape/dismissal, scroll lock, and transitions. Preserve stable content through exits with `useLatchedValue` where needed; clear secrets according to the security lifecycle. Features compose a dialog rather than implementing another frame.

Use `@meltiply/ui/toast` and `@meltiply/ui/sileo` for transient outcomes, with the affected object and useful recovery. Clipboard feedback includes the copied value. Keep inline validation and durable failures beside their controls/records. Accepted delivery is not published success.

## Public surfaces and verification

Landing and docs share palette/fonts but serve different jobs: product explanation and reading. `DocumentationSearchTrigger` opens the canonical article-index dialog from both landing and documentation preferences; it is separate from workspace jump search. Public scrolling/navigation adapters release state during Astro swaps. Native links, keyboard navigation, fragments, and accessibility behavior remain usable.

For each change: read the owner/caller, extend the canonical implementation, migrate callers and guides, and exercise actual states at desktop/phone widths in both palettes. Verify focus, hover, busy, loading, empty, recoverable errors, selection, and nested overflow. Follow the repository's hosted completion gate. Compilation and lint are not visual proof; report only verification actually exercised.
