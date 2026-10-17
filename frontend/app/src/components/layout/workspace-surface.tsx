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
 * gutter while List/Table rows reach the working-area edges. Board/Grid own
 * their inner gutters. No inset page card or stacked outer gaps survive.
 * Controls and collection state remain mounted under the persistent shell.
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
      <header className="flex shrink-0 flex-wrap items-start gap-3 px-4 pb-3 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0">
          <h1 className="m-0 text-page-title font-semibold leading-tight tracking-page-title">
            {title}
          </h1>
          <p className="mt-1 text-ui text-ink-2">{description}</p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">{actions}</div>}
      </header>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", contentClassName)}>{children}</div>
    </div>
  );
}
