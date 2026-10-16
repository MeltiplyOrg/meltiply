import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./button";
import { CenterDialogDescription, CenterDialogHeader, CenterDialogTitle } from "./center-dialog";
import { cn } from "@meltiply/ui/utils";

/**
 * Controlled content for a modal side panel; callers own its real title, body,
 * and optional actions while the component supplies accessible dialog chrome.
 */
export interface SideDialogProps {
  /** Whether the modal side panel is currently open. */
  open: boolean;
  /** Receives Radix dismissal requests from Escape, the backdrop, or Close. */
  onOpenChange: (open: boolean) => void;
  /** Required accessible heading displayed in the fixed header. */
  title: React.ReactNode;
  /** Optional accessible supporting text; omitted without a description warning when absent. */
  description?: React.ReactNode;
  /** Post details or other caller-owned content rendered in the scrollable body. */
  children: React.ReactNode;
  /** Optional actions rendered in a fixed, wrapping footer. */
  footer?: React.ReactNode;
  /** Optional classes merged onto the dialog panel. */
  className?: string;
  /** Accessible label for the Close control; localized callers pass their string. */
  closeLabel?: string;
}

/**
 * The side dialog type: a large modal panel anchored to the right edge, for
 * inspecting rich records such as Post details. Compact tasks use
 * `CenterDialog`. Fixed heading and optional footer frame a native scroll
 * region. Radix supplies dismissal and focus trapping; opening focuses the
 * safe Close control, while closing restores the pre-open element only if it
 * remains connected. Slides in from the right edge (300ms) and back out to it
 * (200ms) without fading; shared motion CSS collapses the slide when low
 * motion is active.
 */
export function SideDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  closeLabel = "Close",
}: SideDialogProps): React.ReactElement {
  const previousActiveElement = React.useRef<HTMLElement | null>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const hasDescription = description !== undefined && description !== null && description !== false;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          {...(!hasDescription ? { "aria-describedby": undefined } : {})}
          onOpenAutoFocus={(event) => {
            const activeElement = document.activeElement;
            previousActiveElement.current =
              activeElement instanceof HTMLElement ? activeElement : null;
            event.preventDefault();
            closeButtonRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const activeElement = previousActiveElement.current;
            previousActiveElement.current = null;
            if (activeElement?.isConnected) activeElement.focus();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-dvh w-full min-w-0 max-w-2xl flex-col overflow-hidden border-l border-border bg-background shadow-lg",
            "data-[state=open]:animate-dialog-slide-in-right data-[state=closed]:animate-dialog-slide-out-right",
            className,
          )}
        >
          <CenterDialogHeader className="flex-row items-start justify-between gap-4 border-b border-border p-4 text-left sm:p-6">
            <div className="min-w-0 flex-1">
              <CenterDialogTitle>{title}</CenterDialogTitle>
              {hasDescription ? (
                <CenterDialogDescription>{description}</CenterDialogDescription>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                ref={closeButtonRef}
                variant="ghost"
                size="icon"
                aria-label={closeLabel}
                className="shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </CenterDialogHeader>
          <div
            data-lenis-prevent=""
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6"
          >
            {children}
          </div>
          {footer !== undefined && footer !== null ? (
            <footer className="min-w-0 shrink-0 border-t border-border p-4 sm:p-6">
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 [&>*]:max-w-full [&>*]:min-w-0">
                {footer}
              </div>
            </footer>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
