import type { ComponentProps } from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Shared semantic table for spreadsheet views and account directories.
 * Callers own data, columns, grouping, selection, and the scroll viewport;
 * variants centralize density/dividers without copying table styling per route.
 */
export function Table({
  variant = "spreadsheet",
  className,
  ...props
}: ComponentProps<"table"> & { variant?: "spreadsheet" | "directory" }) {
  return (
    <table
      data-variant={variant}
      className={cn(
        "group/table w-full table-fixed border-separate border-spacing-0 text-(length:--font-size-control)",
        variant === "spreadsheet" && "[&_th]:border-r [&_td]:border-r [&_td]:border-line-soft",
        className,
      )}
      {...props}
    />
  );
}

/** Keeps native header semantics; cells own sticky positioning within the caller's viewport. */
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={className} {...props} />;
}

/** Preserves native row grouping for screen readers and collection group headers. */
export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={className} {...props} />;
}

/** Shared row selection/hover treatment; focus-within reveals route-owned quick actions. */
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("group/row hover:bg-hover data-[selected=true]:bg-accent-tint", className)}
      {...props}
    />
  );
}

/** Sticky reference header: 32px for Tasks views, 40px for the inset directory. */
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 h-8 border-b border-line bg-surface px-2 text-left text-xs font-medium text-ink-3 first:pl-4 sm:first:pl-6 group-data-[variant=directory]/table:h-10",
        className,
      )}
      {...props}
    />
  );
}

/** Reference-density cell; directory and spreadsheet variants share the same spacing contract. */
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "h-10 border-b border-line-soft px-2 text-ink-2 first:pl-4 sm:first:pl-6 group-data-[variant=spreadsheet]/table:h-9 group-data-[variant=directory]/table:h-16 group-data-[variant=directory]/table:py-2.5",
        className,
      )}
      {...props}
    />
  );
}
