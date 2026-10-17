# Workspace interactions

Shared primitives own interaction mechanics; features supply real state and actions. Use [shared UI ownership](../../../docs/frontend-ui.md) for canonical modules and [layout](../../../docs/frontend-layout.md) for geometry.

## Controls and state

Use semantic surface/field colors, clear hover/active feedback, visible focus, and named icon-only buttons. Busy states prevent duplicate mutations while retaining useful labels. Empty/error states identify the missing state or failure and expose the next safe action.

Keep inputs, buttons, and filters mounted as labels change. Preserve drafts, selection, and focus through recoverable errors. Actual provider outcomes remain observed data, not editable completion flags.

## Navigation and collections

Posts and Channels are single destinations. The Posts toolbar orders Table, Calendar, Grid. Top-bar jump search finds supported destinations and loaded Brand Profiles; collection search and the field-row Filter builder narrow route data. Profiles are scope, not sidebar navigation.

The rail and the Settings section rail mark every row as a glide target and let `SidebarGlideHighlight` (`@meltiply/ui/sidebar-glide-highlight`) own the hover background: one pill springs to the hovered row and fades out on leave, so rows do not paint their own hover fill. Rows stay above the pill, keyboard focus rings and the selected surface remain the row's own paint, and the public docs rail reuses the same component with its nested-scroll viewport.

The Filter builder adds supported equality rows through field chips. Adding an empty row does not change results. Removing a row clears its value; Clear all resets the builder. Nested portalled controls stay inside the disclosure interaction and keyboard focus returns to a useful control.

Selection belongs to the feature, survives view/filter/group presentation changes, and excludes unloaded records. Select-all is visually checked only for a fully selected visible set. The shared pill reports the actual count; destructive actions confirm a fixed target snapshot and retain failed targets for retry.

## Dialogs and Settings

Use `CenterDialog` for focused tasks/search, `CenterAlertDialog` for destructive confirmation, and `SideDialog` for large Post inspection. Primitives own focus, dismissal, scroll lock, opener restoration, and exit retention. Keep data through exits with `useLatchedValue` where needed; clear secrets according to security requirements, not cosmetic timing.

Post inspection uses real properties, caption, attachments, and Channel outcomes. Header actions expose supported editing/deletion/cancellation; expansion and Close belong to the shared drawer.

Settings has Appearance, Language, Account, and Security. Every section shares the same content maximum and surface background. Theme offers Light, Dark, and System through the existing consent-aware owner. The sidebar account menu exposes the same three choices inline; selecting one applies immediately without dismissing the menu. Identity is read-only. Security controls are inline and retain password reauthentication, authenticator verification, and recovery-code handling.

## Animation and feedback

Preserve existing animations and extend their canonical owners when requested. There is one implementation path, without motion-mode state, providers, storage, flags, alternate branches, or a rule requiring such guards for new animation work.

Use `@meltiply/ui/toast` and Sileo for transient outcomes. Name the affected object and useful recovery action; clipboard feedback includes the copied value. Keep validation beside the input and durable failures beside the affected record. Accepted/queued work is not published success.
