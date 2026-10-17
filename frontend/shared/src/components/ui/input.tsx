import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Properties for the {@link Input} component.
 *
 * Inherits standard HTML `<input>` attributes including `type`, `value`, `placeholder`,
 * `disabled`, `onChange`, and `onKeyDown`.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Standard form input field styled with consistent borders, typography, and focus rings.
 *
 * Wraps a native HTML input with compact 30px sizing, opaque field fill,
 * custom file upload button styling (`file:border-0 file:bg-transparent`), placeholder colors, and accessible
 * keyboard focus ring styling (`focus-visible:ring-1 focus-visible:ring-ring`).
 *
 * Checkboxes and radios opt out of text-input chrome, retaining compact native control
 * geometry and the theme accent. Radio groups preserve native keyboard selection while
 * using the same lint-sanctioned primitive as every other form control.
 *
 * @param className - Additional CSS class names merged onto the input element.
 * @param type - Native HTML input type; checkbox and radio use compact control styling.
 * @param props - Remaining HTML input attributes forwarded directly to `<input>`.
 * @param ref - Forwarded ref attached to the underlying `<HTMLInputElement>`.
 * @returns Styled input element.
 *
 * @example
 * ```tsx
 * <Input type="email" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
 * ```
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          type === "checkbox" || type === "radio"
            ? "size-4 shrink-0 accent-primary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            : "flex h-[30px] w-full rounded-control border border-line-strong bg-field px-2.5 py-1 text-[13px] transition-colors duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
