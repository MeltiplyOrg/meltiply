# Workspace interactions

Use the Gr8r-adapted compact control vocabulary without adding choreography to
publishing tasks. Shared primitives own interaction details; route code supplies
real state and actions.

## Control states

- Idle: semantic field/surface colors and one boundary.
- Hover and active: bounded neutral or accent color feedback.
- Focus-visible: a clear accent ring/outline; icon-only buttons have names.
- Disabled/busy: prevent duplicate actions and retain useful labels.
- Empty/error: name the missing state or failure and offer the next safe action.

Keep buttons, inputs, and filters mounted across label changes. Preserve focus,
selection, and unsaved content; do not split or stagger page-heading words.
Navigation and theme selection update immediately. Any retained transition must
honor reduced motion and cannot delay access to the task.

## Navigation and search

Navigation rows use an immediate neutral hover/selected surface. The sidebar is
252px or a 52px icon rail; collapsed actions retain accessible labels. A separate
chevron controls Posts sub-navigation, never a button nested in a route button.
The top bar and sidebar open the same jump palette. Shortcut definitions and
platform-correct hints come from `lib/hotkeys.ts`.

Jump search filters supported pages and loaded Brand Profiles. Native Tab/Enter
navigation and Escape dismissal remain available. Search Posts and Channels
through their collection toolbar; never imply a global content index.

## Dialogs

Use `CenterDialog` for focused tasks, `CenterAlertDialog` for destructive
confirmation, and `SideDialog` for large Post inspection. Shared primitives own
focus trapping, Escape, scroll lock, focus restoration, and any retained exit
lifecycle. Keep data stable through an exit with `useLatchedValue` when needed;
clear secrets according to the account-security lifecycle, not cosmetic timing.

Settings composes the same controls into Appearance, Account, and Security. Theme
cards call the existing consent-aware provider. Identity is read-only; account
security keeps its password, authenticator, and recovery-code requirements.

## Feedback

Use the shared `@meltiply/ui/toast` store and Sileo renderer. Confirm actual
outcomes, name the affected object, and include a recovery action when useful.
Clipboard feedback includes the copied value. Inline validation stays beside its
input. A pending provider operation must not masquerade as published success.
