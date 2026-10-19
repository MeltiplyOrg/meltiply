import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@meltiply/ui/utils";

/**
 * Props for configuring the interactive Button component.
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * When true, delegates rendering to its child element using Radix Slot composition,
   * merging styles and props onto the child (e.g. Next.js Link or custom anchor tags).
   * @defaultValue `false`
   */
  asChild?: boolean;
  /**
   * Visual style variant representing intent, hierarchy, or visual weight.
   * @defaultValue `'default'`
   */
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  /**
   * Size presets configuring height, padding, typography, and icon dimensions.
   * @defaultValue `'default'`
   */
  size?: "default" | "sm" | "lg" | "icon";
}

/**
 * Mapping of visual intent variants to corresponding Tailwind token classes.
 */
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

/**
 * Mapping of button size presets to layout and padding classes.
 */
const sizeStyles: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-[30px] px-[11px] text-[12.5px]",
  sm: "h-[26px] px-2 text-xs",
  lg: "h-9 px-3.5 text-[13.5px]",
  icon: "size-[30px] pointer-coarse:min-w-11",
};

/**
 * Resolves the composed class list for a button variant/size pair so sibling
 * primitives (e.g. `AlertDialogAction`) can reuse the canonical button styling
 * without rendering a `Button` element.
 *
 * Descendant SVGs default to 16px (`size-4`) via an arbitrary-variant rule that
 * only matches icons without an authored `size-*` utility, so callers keep
 * compact icons (e.g. `size-3`, `size-full`) at their exact dimensions while
 * unsized icons still get the standard default.
 * Coarse pointers get a 44px minimum height (and square icon targets); compact
 * fine-pointer geometry stays unchanged even on a narrow desktop window.
 *
 * @param options.variant - Visual style variant; defaults to `default`.
 * @param options.size - Size preset; defaults to `default`.
 * @param options.className - Optional extra classes merged last.
 * @returns Merged Tailwind class string.
 */
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

/**
 * Core interactive button component supporting multiple variants, sizes, and slot composition.
 *
 * Handles focus-visible rings, disabled opacity/pointer states, active color feedback,
 * and SVG icon sizing that defaults unsized icons to 16px while preserving authored
 * `size-*` utilities. When `asChild` is enabled, delegates rendering to the direct child.
 *
 * @param className - Optional CSS class overrides merged with computed variant and size styles.
 * @param variant - Optional visual style variant determining color and hover treatment;
 *   falls back to `default` when omitted (pick `ghost`/`link` for utility controls,
 *   `default` only for primary actions).
 * @param size - Size preset determining dimensions, padding, and text scale.
 * @param asChild - When true, delegates rendering to child via Radix Slot.
 * @param props - Standard HTML button attributes forwarded to the underlying element.
 * @param ref - Forwarded DOM reference to the HTML button or slot element.
 *
 * @example
 * ```tsx
 * <Button variant="outline" size="sm" onClick={handleSave}>
 *   Save Changes
 * </Button>
 *
 * <Button asChild variant="ghost" size="icon">
 *   <a href="/settings" aria-label="Settings"><SettingsIcon /></a>
 * </Button>
 * ```
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={buttonVariants({ variant, size, className })} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";
