import * as React from "react";
import { cn } from "@meltiply/ui/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function inputVariants({ type, className }: Pick<InputProps, "type" | "className"> = {}) {
  return cn(
    type === "checkbox" || type === "radio"
      ? "size-4 shrink-0 accent-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      : "flex h-[30px] min-w-0 w-full rounded-control border border-line-strong bg-field px-2.5 py-1 text-[13px] transition-colors duration-150 pointer-coarse:min-h-11 pointer-coarse:text-base file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
    className,
  );
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input type={type} className={inputVariants({ type, className })} ref={ref} {...props} />
    );
  },
);
Input.displayName = "Input";
