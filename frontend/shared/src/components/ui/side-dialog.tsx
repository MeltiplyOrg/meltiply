import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { cn } from "@meltiply/ui/utils";

/** Record content and real actions for the shared Gr8r-style inspection drawer. */
export interface SideDialogProps {
  open: boolean;
  /**
   * Receives dismissal requests from Escape or Close; the drawer ignores outside
   * clicks so the workspace stays live while a record is inspected.
   */
  onOpenChange: (open: boolean) => void;
  /** Required accessible dialog heading, visually hidden when breadcrumb is supplied. */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Record context displayed at the left of the compact header. */
  breadcrumb?: React.ReactNode;
  /** Caller-owned supported actions; Close remains canonical. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Extra classes for the scrolling body, e.g. removing its bottom padding so a
   * pinned action bar can sit flush against the drawer's bottom edge.
   */
  bodyClassName?: string;
  className?: string;
  closeLabel?: string;
}

/**
 * Ports Gr8r's 620px edge drawer and 46px record toolbar. The drawer is a
 * non-modal companion, as in the reference: the workspace keeps painting and
 * taking input, so clicking another record re-inspects it in place instead of
 * being swallowed by a scrim. Radix still owns Escape dismissal, the portal, and
 * opener restoration without scrolling the workspace; the inspection container
 * receives initial focus so a toolbar tooltip cannot consume the first Escape.
 * Keyboard focus is deliberately not trapped: this companion panel lets Tab
 * reach the workspace. Native body scrolling stays untouched. Motion is the
 * reference drawer's: the panel steps 48px in on `--ease-drawer` and slides back
 * out on dismissal (`side-dialog-enter`/`side-dialog-exit`), its body blocks rise
 * behind the panel with a 0/55/105/150ms stagger (`side-dialog-rise-in`).
 * Feature-owned keyed sections replay the entrance when their record changes,
 * while retained sections keep their state and effects.
 */
export function SideDialog({
  open,
  onOpenChange,
  title,
  description,
  breadcrumb,
  actions,
  children,
  bodyClassName,
  className,
  closeLabel = "Close",
}: SideDialogProps): React.ReactElement {
  const previousActiveElement = React.useRef<HTMLElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const hasDescription = description !== undefined && description !== null && description !== false;
  const hasBreadcrumb = breadcrumb !== undefined && breadcrumb !== null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={contentRef}
          data-side-dialog=""
          {...(!hasDescription ? { "aria-describedby": undefined } : {})}
          onInteractOutside={(event) => {
            // A companion panel ignores outside use: the workspace stays live so
            // another record can be inspected in place.
            event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            previousActiveElement.current = active instanceof HTMLElement ? active : null;
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const active = previousActiveElement.current;
            previousActiveElement.current = null;
            if (active?.isConnected) active.focus({ preventScroll: true });
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-dvh w-full min-w-0 flex-col overflow-hidden border-l border-line bg-surface pt-(--safe-area-top) shadow-overlay outline-none sm:max-w-155",
            className,
          )}
        >
          <TooltipProvider>
            <header className="flex min-h-11.5 shrink-0 flex-wrap items-center gap-1 border-b border-line py-1 pl-4 pr-2.5">
              <div className="min-w-0 flex-1 truncate text-(length:--font-size-control) text-ink-2">
                <DialogPrimitive.Title
                  className={
                    hasBreadcrumb
                      ? "sr-only"
                      : "text-(length:--font-size-control) font-medium text-ink"
                  }
                >
                  {title}
                </DialogPrimitive.Title>
                {hasBreadcrumb && breadcrumb}
                {hasDescription && (
                  <DialogPrimitive.Description className="sr-only">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">{actions}</div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DialogPrimitive.Close asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={closeLabel}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </DialogPrimitive.Close>
                </TooltipTrigger>
                <TooltipContent>
                  {closeLabel}
                  <kbd className="ml-2 text-tooltip-muted">Esc</kbd>
                </TooltipContent>
              </Tooltip>
            </header>
          </TooltipProvider>
          <div
            data-lenis-prevent=""
            data-side-dialog-body=""
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-(--safe-content-bottom) pt-4 sm:px-6 sm:pb-8 sm:pt-5",
              bodyClassName,
            )}
          >
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
