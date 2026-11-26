import type { ComponentProps } from "react";
import { cn } from "@meltiply/ui/utils";

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

export function TableHeader(props: ComponentProps<"thead">) {
  return <thead {...props} />;
}

export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("group/row hover:bg-hover data-[selected=true]:bg-accent-tint", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 h-8 border-b border-line bg-surface px-2 text-left text-xs font-medium text-ink-3 first:pl-4 sm:first:pl-6 group-data-[variant=directory]/table:h-10 group-data-[variant=directory]/table:border-t",
        className,
      )}
      {...props}
    />
  );
}

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
