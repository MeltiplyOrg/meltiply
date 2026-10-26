/**
 * Class contract shared by the centered dialog surfaces. `CenterDialogContent`
 * and `CenterAlertDialogContent` paint the same backdrop, surface, header,
 * footer, title, and description; Radix's Dialog or AlertDialog primitive owns
 * dismissal and focus behavior, and each surface adds only its intentional
 * width. Callers may append layout overrides through `className`.
 */
export const dialogChrome = {
  /** Fullscreen scrim behind either centered surface. */
  backdrop:
    "fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
  /** Dynamic-viewport surface geometry without a width; each owner sets its own. */
  surface:
    "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] content-start -translate-x-1/2 -translate-y-1/2 gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-window border border-line bg-surface p-4 shadow-overlay dialog-bottom-popup sm:p-6",
  /** Title and description block, left aligned at every width. */
  header: "flex flex-col gap-1.5 text-left",
  /** Action row that stacks on phones and right-aligns on wider screens. */
  footer: "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
  /** Dialog heading typography. */
  title: "text-base font-semibold text-ink",
  /** Supporting copy under the heading. */
  description: "text-[13px] leading-relaxed text-ink-2",
} as const;
