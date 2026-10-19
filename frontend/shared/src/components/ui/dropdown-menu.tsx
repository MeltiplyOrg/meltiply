import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { SlidingHighlight } from "../primitives/sliding-highlight";
/**
 * Root container for dropdown menus built on Radix DropdownMenu.
 *
 * Manages open/closed state, modal trapping, focus management, and keyboard navigation.
 *
 * @example
 * ```tsx
 * <DropdownMenu>
 *   <DropdownMenuTrigger asChild><Button variant="ghost">Options</Button></DropdownMenuTrigger>
 *   <DropdownMenuContent>
 *     <DropdownMenuItem onClick={handleEdit}>Edit</DropdownMenuItem>
 *     <DropdownMenuSeparator />
 *     <DropdownMenuItem onClick={handleDelete}>Delete</DropdownMenuItem>
 *   </DropdownMenuContent>
 * </DropdownMenu>
 * ```
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;

/**
 * Interactive button or element that toggles the dropdown menu visibility.
 *
 * Usually wraps a button component via `asChild` prop.
 */
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/**
 * Groups related {@link DropdownMenuItem} elements under an accessible category.
 */

/**
 * Portals dropdown menu items into `document.body` to avoid clipping by overflow or z-index constraints.
 */

/**
 * Root container for nested submenu flyouts within a dropdown menu.
 */

/**
 * Container for grouping mutually exclusive {@link DropdownMenuRadioItem} components.
 *
 * Manages controlled (`value`, `onValueChange`) radio selection state.
 */
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * Submenu trigger item that reveals a nested {@link DropdownMenuSubContent} on
 * hover or ArrowRight; styled by the shared `[data-menu-item]` vocabulary so a
 * submenu row matches every other menu row.
 *
 * @param className - Optional CSS classes for custom styling.
 * @param children - Trigger label or content.
 * @param props - Radix SubTrigger props.
 * @param ref - Forwarded ref to the subtrigger element.
 * @returns Styled submenu trigger item.
 */
const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn("cursor-default select-none pr-8", className)}
    {...props}
  >
    {children}
    <ChevronRight className="size-4" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

/**
 * Floating panel containing nested submenu items.
 *
 * Uses a stable Popper position with opacity-only entrance/exit feedback so the
 * submenu does not fight Radix's positioning transform during opening.
 *
 * @param className - Optional CSS classes for width, padding, or borders.
 * @param highlight - Renders the travelling highlight pill (defaults to true).
 *   Pass false to mark the surface data-menu-plain, whose shared rule paints
 *   each row's own hover/highlight fill instead of moving the pill.
 * @param props - Radix SubContent props.
 * @param ref - Forwarded ref.
 * @returns Styled submenu content overlay.
 */
const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> & { highlight?: boolean }
>(({ className, highlight = true, children, ...props }, ref) => {
  const subContentRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      subContentRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  return (
    <DropdownMenuPrimitive.SubContent
      ref={setRefs}
      data-menu-surface=""
      data-menu-plain={highlight ? undefined : ""}
      className={cn("relative z-50 select-none", className)}
      {...props}
    >
      {highlight && (
        <SlidingHighlight
          containerRef={subContentRef}
          itemSelector="[data-dropdown-item]"
          deferUntilInteraction
        />
      )}
      {children}
    </DropdownMenuPrimitive.SubContent>
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;
/**
 * Main floating popover menu panel rendered inside a {@link DropdownMenuPortal}.
 *
 * Uses a stable Popper position with opacity-only entrance/exit feedback so the
 * menu does not fight Radix's positioning transform during opening.
 *
 * @param sideOffset - Distance in pixels from the trigger (defaults to 4px).
 * @param className - Optional CSS classes for custom width, max-height, or styling.
 * @param highlight - Renders the travelling highlight pill (defaults to true).
 *   Pass false to mark the surface data-menu-plain, whose shared rule paints
 *   each row's own hover/highlight fill instead of moving the pill.
 * @param props - Remaining Radix Content props.
 * @param ref - Forwarded ref.
 * @returns Styled portalled dropdown content container.
 */
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & { highlight?: boolean }
>(({ className, sideOffset = 4, highlight = true, children, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={setRefs}
        sideOffset={sideOffset}
        data-menu-surface=""
        data-menu-plain={highlight ? undefined : ""}
        className={cn("relative z-50 select-none", className)}
        {...props}
      >
        {highlight && (
          <SlidingHighlight
            containerRef={contentRef}
            itemSelector="[data-dropdown-item]"
            deferUntilInteraction
          />
        )}
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

/**
 * Actionable item within a dropdown menu.
 *
 * Chrome (row geometry, tokens, and hover suppression for the shared
 * `SlidingHighlight` pill) comes from the `[data-menu-item]` hook, so every
 * menu family — this one, `Select`, and page-composed panels — renders
 * identically.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix Item props.
 * @param ref - Forwarded ref.
 * @returns Styled dropdown menu item.
 */
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn("cursor-default select-none", className)}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

/**
 * Toggleable checkbox item within a dropdown menu.
 *
 * Renders a right-aligned accent checkmark when `checked` is true, matching
 * {@link DropdownMenuRadioItem} and the item indicator inside `Select`.
 *
 * @param checked - Checked state (boolean or 'indeterminate').
 * @param className - Optional CSS classes.
 * @param children - Item label.
 * @param props - Radix CheckboxItem props.
 * @param ref - Forwarded ref.
 * @returns Styled dropdown checkbox item with indicator.
 */
export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn("cursor-default select-none pr-8", className)}
    checked={checked}
    {...props}
  >
    {children}
    <span data-menu-indicator="">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/**
 * Selectable radio option within a {@link DropdownMenuRadioGroup}. The default
 * layout is a menu row with a right-aligned accent check; `segment` joins
 * compact horizontal choices with neutral selected styling. Radix retains menu
 * arrow-key navigation and checked semantics. Callers may prevent selection
 * dismissal for immediate preferences.
 *
 * @param value - Value of this radio option.
 * @param variant - `default` row or `segment` cell inside a segmented group.
 * @param className - Optional CSS classes.
 * @param children - Option label.
 * @param props - Radix RadioItem props.
 * @param ref - Forwarded ref.
 * @returns Styled dropdown radio item with indicator.
 */
export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & {
    variant?: "default" | "segment";
  }
>(({ className, children, variant = "default", ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn(
      "cursor-default select-none",
      variant === "segment"
        ? "h-6 min-h-6 flex-1 justify-center gap-1 rounded-control px-2 text-xs font-medium text-ink-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[highlighted]:text-ink data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-btn"
        : "pr-8",
      className,
    )}
    {...props}
  >
    {children}
    {variant === "default" && (
      <span data-menu-indicator="">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    )}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

/**
 * Non-interactive category header label within a dropdown menu; styled by the
 * shared `[data-menu-label]` menu vocabulary.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix Label props.
 * @param ref - Forwarded ref.
 * @returns Styled section label.
 */
export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} data-menu-label="" className={className} {...props} />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

/**
 * Visual separator dividing items or groups within a dropdown menu; styled by
 * the shared `[data-menu-separator]` menu vocabulary.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix Separator props.
 * @param ref - Forwarded ref.
 * @returns Styled menu separator line.
 */
export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    data-menu-separator=""
    className={className}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

/**
 * Controlled filter checklist. Empty selection means all; choosing the aggregate
 * row clears the selection. Toggling concrete values keeps the menu open, while
 * Radix owns keyboard navigation, dismissal, and trigger focus restoration.
 * Callers own option identity, labels, ordering, and filtering semantics.
 */
export function FilterChecklist<Value extends string>({
  value,
  onValueChange,
  options,
  aggregateLabel,
  trigger,
  label,
  className,
}: {
  value: readonly Value[];
  onValueChange: (value: Value[]) => void;
  options: readonly { value: Value; label: React.ReactNode }[];
  aggregateLabel: string;
  trigger: React.ReactElement;
  label?: string;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={className}
        {...(label ? { "aria-label": label, "aria-labelledby": undefined } : {})}
      >
        <DropdownMenuCheckboxItem
          checked={value.length === 0}
          onCheckedChange={() => onValueChange([])}
          onSelect={(event) => event.preventDefault()}
        >
          {aggregateLabel}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={value.includes(option.value)}
            onCheckedChange={() =>
              onValueChange(
                value.includes(option.value)
                  ? value.filter((selected) => selected !== option.value)
                  : [...value, option.value],
              )
            }
            onSelect={(event) => event.preventDefault()}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
