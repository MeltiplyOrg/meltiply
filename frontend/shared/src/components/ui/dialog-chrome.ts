export const dialogChrome = {
  backdrop: "fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm",
  surface:
    "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] content-start -translate-x-1/2 -translate-y-1/2 gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-window border border-line bg-surface p-4 shadow-overlay dialog-bottom-popup sm:p-6",
  header: "flex flex-col gap-1.5 text-left",
  footer: "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
  title: "text-base font-semibold text-ink",
  description: "text-[13px] leading-relaxed text-ink-2",
} as const;
