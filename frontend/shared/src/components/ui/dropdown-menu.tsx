import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { SlidingMenuHighlight } from "../primitives/sliding-menu-highlight";
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

/**
 * Submenu trigger item that reveals a nested {@link DropdownMenuSubContent} on hover or arrow-right keypress.
 *
 * Renders an automatic trailing chevron icon indicating an expandable submenu.
 *
 * @param inset - When true, adds left padding (`pl-8`) to align text with items that have leading icons or indicators.
 * @param className - Optional CSS classes for custom styling.
 * @param children - Trigger label or content.
 * @param props - Radix SubTrigger props.
 * @param ref - Forwarded ref to the subtrigger element.
 * @returns Styled submenu trigger item.
 */
const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    data-dropdown-item
    className={cn(
      "relative z-10 flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-transparent data-[state=open]:bg-transparent data-[highlighted]:bg-transparent hover:bg-transparent text-ink focus:text-ink",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto size-4" />
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
 * @param props - Radix SubContent props.
 * @param ref - Forwarded ref.
 * @returns Styled submenu content overlay.
 */
const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, children, ...props }, ref) => {
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
      className={cn(
        "relative z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg select-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    >
      <SlidingMenuHighlight containerRef={subContentRef} itemSelector="[data-dropdown-item]" />
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
 * @param props - Remaining Radix Content props.
 * @param ref - Forwarded ref.
 * @returns Styled portalled dropdown content container.
 */
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => {
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
        className={cn(
          "relative z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md select-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      >
        <SlidingMenuHighlight containerRef={contentRef} itemSelector="[data-dropdown-item]" />
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

/**
 * Actionable item within a dropdown menu.
 *
 * Handles mouse click and keyboard selection, visual focus highlighting (`focus:bg-accent`),
 * disabled state opacity, and icon sizing constraints.
 *
 * @param inset - When true, indents the item (`pl-8`) to align with checkbox/radio items.
 * @param className - Optional CSS classes.
 * @param props - Radix Item props.
 * @param ref - Forwarded ref.
 * @returns Styled dropdown menu item.
 */
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-dropdown-item
    className={cn(
      "relative z-10 flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
      "focus:bg-transparent data-[highlighted]:bg-transparent hover:bg-transparent text-ink focus:text-ink data-[highlighted]:text-ink",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

/**
 * Toggleable checkbox item within a dropdown menu.
 *
 * Renders a left-aligned checkmark indicator icon when `checked` is true.
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
    className={cn(
      "relative z-10 flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-transparent data-[highlighted]:bg-transparent hover:bg-transparent text-ink focus:text-ink data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/**
 * Selectable radio option within a {@link DropdownMenuRadioGroup}.
 *
 * Renders a left-aligned bullet circle indicator when active.
 *
 * @param value - Value of this radio option.
 * @param className - Optional CSS classes.
 * @param children - Option label.
 * @param props - Radix RadioItem props.
 * @param ref - Forwarded ref.
 * @returns Styled dropdown radio item with indicator.
 */
const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    data-dropdown-item
    className={cn(
      "relative z-10 flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-transparent data-[highlighted]:bg-transparent hover:bg-transparent text-ink focus:text-ink data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle className="size-2 fill-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

/**
 * Non-interactive category header label within a dropdown menu.
 *
 * @param inset - When true, indents the label (`pl-8`) to align with checkbox/radio items.
 * @param className - Optional CSS classes.
 * @param props - Radix Label props.
 * @param ref - Forwarded ref.
 * @returns Styled section label.
 */
const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-xs font-semibold text-muted-foreground",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

/**
 * Visual separator dividing items or groups within a dropdown menu.
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
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
