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
 * Shared Gr8r-adapted page composition: compact 23px title, supporting context,
 * aligned actions, then toolbar and working collection. The shell owns gutters;
 * route content owns its bounded scroll region. Text changes synchronously so
 * headings never duplicate or delay the next task, including reduced motion.
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
    <div className={cn("flex h-full min-h-0 w-full flex-col gap-5 overflow-hidden", className)}>
      <header className="flex shrink-0 flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h1 className="text-page-title leading-8 font-semibold tracking-page-title text-ink">
            {title}
          </h1>
          <p className="mt-1 text-[13px] leading-5 text-ink-2">{description}</p>
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-1">{actions}</div>
        )}
      </header>
      <div className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-hidden", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
