import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { cn } from "@meltiply/ui/utils";

/** Record content and real actions for the shared Gr8r-style inspection drawer. */
export interface SideDialogProps {
  open: boolean;
  /**
   * Receives dismissal requests from Escape, Close, or the expanded scrim; the
   * edge inspector ignores outside clicks so the workspace stays live.
   */
  onOpenChange: (open: boolean) => void;
  /** Required accessible dialog heading, visually hidden when breadcrumb is supplied. */
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Record context displayed at the left of the compact header. */
  breadcrumb?: React.ReactNode;
  /** Caller-owned supported actions; expand and close remain canonical. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  closeLabel?: string;
  expandLabel?: string;
  restoreLabel?: string;
}

/**
 * Ports Gr8r's 620px edge drawer, 46px record toolbar, and optional 980px expanded
 * inspector. The drawer is a non-modal companion, as in the reference: the
 * workspace keeps painting and taking input, so clicking another record
 * re-inspects it in place instead of being swallowed by a scrim. Only the
 * expanded inspector renders a scrim, and clicking that scrim dismisses. Radix
 * still owns Escape dismissal, the portal, and opener restoration; the
 * inspection container receives initial focus so a toolbar tooltip cannot
 * consume the first Escape. Keyboard focus is deliberately not trapped: this is
 * a companion panel over live content, so Tab reaches the workspace.
 * Native body scrolling stays untouched. Motion is the reference drawer's: the
 * panel steps 48px in on `--ease-drawer` and slides back out on dismissal
 * (`side-dialog-enter`/`side-dialog-exit`, which read their shape from custom
 * properties so expanding never replays the entrance), and its body blocks rise
 * behind the panel with a 0/55/105/150ms stagger (`side-dialog-rise-in`).
 */
export function SideDialog({
  open,
  onOpenChange,
  title,
  description,
  breadcrumb,
  actions,
  children,
  className,
  closeLabel = "Close",
  expandLabel = "Expand panel",
  restoreLabel = "Restore side panel",
}: SideDialogProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const previousActiveElement = React.useRef<HTMLElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const hasDescription = description !== undefined && description !== null && description !== false;
  const hasBreadcrumb = breadcrumb !== undefined && breadcrumb !== null;
  const expandAction = expanded ? restoreLabel : expandLabel;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        {/* The reference scrim exists only for the expanded inspector: it fades in
            on expand and stays inert and invisible otherwise, so the edge drawer
            never blocks the workspace. Radix keeps each portal child mounted for
            its own exit animation. */}
        <div
          data-side-dialog-scrim=""
          data-state={expanded && open ? "open" : "closed"}
          aria-hidden="true"
          className={cn("fixed inset-0 z-50 bg-overlay/40", !expanded && "pointer-events-none")}
          onClick={() => onOpenChange(false)}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          data-side-dialog=""
          data-expanded={expanded ? "true" : "false"}
          {...(!hasDescription ? { "aria-describedby": undefined } : {})}
          onInteractOutside={(event) => {
            // A companion panel ignores outside use: the workspace stays live so
            // another record can be inspected, and the expanded scrim owns
            // dismissal instead.
            event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            previousActiveElement.current = active instanceof HTMLElement ? active : null;
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const active = previousActiveElement.current;
            previousActiveElement.current = null;
            if (active?.isConnected) active.focus();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-dvh w-full min-w-0 flex-col overflow-hidden border-l border-line bg-surface shadow-overlay outline-none",
            expanded
              ? "sm:inset-y-6 sm:left-1/2 sm:right-auto sm:h-auto sm:w-[min(980px,calc(100vw-48px))] sm:-translate-x-1/2 sm:rounded-xl sm:border"
              : "sm:max-w-155",
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="hidden size-7 sm:inline-flex"
                    aria-label={expandAction}
                    aria-pressed={expanded}
                    onClick={() => setExpanded((previous) => !previous)}
                  >
                    {expanded ? (
                      <Minimize2 className="size-3.75" />
                    ) : (
                      <Maximize2 className="size-3.75" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{expandAction}</TooltipContent>
              </Tooltip>
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
              "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-10 pt-4 sm:px-6 sm:pb-8 sm:pt-5",
              expanded && "sm:px-12 sm:pb-10 sm:pt-7",
            )}
          >
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
