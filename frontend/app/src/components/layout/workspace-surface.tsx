import type { ReactNode } from "react";
import { cn } from "@meltiply/ui/utils";

interface WorkspaceSurfaceProps {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * Gr8r's full-bleed operational page: the header and toolbar own the shared
 * gutter while Table rows reach the working-area edges and Grid owns its
 * inner gutters. No inset page card or stacked outer gaps survive.
 * Controls and collection state remain mounted under the persistent shell.
 *
 * On phones the title and primary actions share one row and the description
 * sits beneath them, so a page does not pay three stacked rows before its
 * collection. Action groups still wrap when they cannot fit beside the title.
 */
export function WorkspaceSurface({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: WorkspaceSurfaceProps) {
  return (
    <div className={cn("flex size-full min-h-0 min-w-0 flex-col bg-surface", className)}>
      <header className="flex shrink-0 flex-col gap-1 px-4 pb-2 pt-4 sm:px-6 sm:pb-3 sm:pt-6">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-(length:--text-title) font-semibold leading-tight tracking-page-title">
              {title}
            </h1>
          </div>
          {actions && (
            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
          )}
        </div>
        <p className="text-(length:--font-size-ui) text-ink-2">{description}</p>
      </header>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", contentClassName)}>{children}</div>
    </div>
  );
}
