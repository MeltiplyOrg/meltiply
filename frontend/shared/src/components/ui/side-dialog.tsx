import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { cn } from "@meltiply/ui/utils";

/** Record content and real actions for the shared Gr8r-style inspection drawer. */
export interface SideDialogProps {
  open: boolean;
  /** Receives dismissal requests from Escape, the outside surface, or Close. */
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
 * inspector. The normal outside surface stays clear; expanded mode dims it.
 * Phones always use the full viewport. Radix retains modal focus/scroll ownership,
 * Escape and outside dismissal. Close receives initial focus; only a connected
 * opener is restored. Native body scrolling and the implemented opacity fade
 * avoid blank slide frames or duplicated page snapshots.
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
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const hasDescription = description !== undefined && description !== null && description !== false;
  const hasBreadcrumb = breadcrumb !== undefined && breadcrumb !== null;
  const expandAction = expanded ? restoreLabel : expandLabel;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn("fixed inset-0 z-50", expanded ? "bg-overlay/40" : "bg-transparent")}
        />
        <DialogPrimitive.Content
          {...(!hasDescription ? { "aria-describedby": undefined } : {})}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            previousActiveElement.current = active instanceof HTMLElement ? active : null;
            event.preventDefault();
            closeButtonRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const active = previousActiveElement.current;
            previousActiveElement.current = null;
            if (active?.isConnected) active.focus();
          }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-dvh w-full min-w-0 flex-col overflow-hidden border-l border-line bg-surface shadow-overlay outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-120 motion-reduce:animate-none",
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
                      ref={closeButtonRef}
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
