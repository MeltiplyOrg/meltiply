import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@meltiply/ui/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
}

const variantStyles: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default: "bg-primary text-primary-foreground shadow-btn hover:bg-primary/90 active:bg-primary/80",
  destructive:
    "bg-destructive text-destructive-foreground shadow-btn hover:bg-destructive/90 active:bg-destructive/80",
  outline:
    "border border-line-strong bg-surface text-ink shadow-btn hover:bg-hover active:bg-hover-2",
  secondary: "bg-secondary text-secondary-foreground hover:bg-hover-2 active:bg-hover-2",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink active:bg-hover-2",
  link: "text-accent-ink underline-offset-4 hover:underline",
};

const sizeStyles: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-[30px] px-[11px] text-[12.5px]",
  sm: "h-[26px] px-2 text-xs",
  lg: "h-9 px-3.5 text-[13.5px]",
  icon: "size-[30px] pointer-coarse:min-w-11",
};

export function buttonVariants(options?: {
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}): string {
  return cn(
    "inline-flex touch-manipulation items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-colors duration-150 pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
    variantStyles[options?.variant ?? "default"],
    sizeStyles[options?.size ?? "default"],
    options?.className,
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={buttonVariants({ variant, size, className })} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";
