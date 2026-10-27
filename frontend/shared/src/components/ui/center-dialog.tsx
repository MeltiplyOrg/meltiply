import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { useCenterDialogMorph } from "./center-dialog-motion";
import { useDialogOpenerFocus } from "./dialog-opener-focus";
import { Button } from "./button";
import { dialogChrome } from "./dialog-chrome";

/**
 * Root of the centered dialog type: a compact modal in the middle of the
 * screen that pops up bottom-up. Use it for forms and short focused tasks;
 * large inspection panels use `SideDialog`, confirmations `CenterAlertDialog`.
 * Direct alias for Radix Dialog `Root`.
 */
export const CenterDialog = DialogPrimitive.Root;

/**
 * Interactive button or element that toggles the dialog open state on click.
 * Direct alias for Radix Dialog `Trigger`.
 */
export const CenterDialogTrigger = DialogPrimitive.Trigger;

/**
 * Portals dialog overlay and content to the document body to prevent stacking context clipping.
 * Direct alias for Radix Dialog `Portal`.
 */
const DialogPortal = DialogPrimitive.Portal;

/**
 * Fullscreen backdrop overlay behind the active modal dialog.
 *
 * Implements backdrop blur and darkened background token with fade in/out animation transitions.
 *
 * @param className - Optional styling class overrides.
 * @param props - Radix Dialog Overlay properties.
 * @param ref - Forwarded DOM reference to the overlay element.
 */
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-dialog-backdrop=""
    className={cn(dialogChrome.backdrop, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export interface CenterDialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /**
   * Accessible name for the canonical close button. Callers pass their
   * localized label; the default keeps standalone usage understandable.
   * @defaultValue `"Close"`
   */
  closeLabel?: string;
}

/**
 * Centered modal that morphs between the two boxes when it hands off to or from
 * another centered dialog: the box changes size in place while its content
 * slides sideways, so a step between dialogs reads as one surface reshaping.
 * Opening with no dialog behind it pops up bottom-up, and the last dialog to
 * close pops out to the bottom. Radix retains content through exit, traps
 * focus, and restores it on close. Shared CSS owns the implemented transitions;
 * callers customize content and layout without duplicating the primitive.
 * The surface bounds itself to the dynamic viewport and owns native overflow;
 * short screens and software-keyboard resizes never put form actions offscreen.
 *
 * Shares `dialogChrome` with `CenterAlertDialogContent`; only the width differs.
 * This ordinary Dialog primitive keeps outside-click and Escape dismissal,
 * while the destructive AlertDialog variant blocks outside dismissal. The
 * canonical ghost icon Button carries the caller's localized close label.
 * Controlled callers restore focus to the element that opened the dialog even
 * without a `CenterDialogTrigger`.
 */
export const CenterDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  CenterDialogContentProps
>(
  (
    { className, children, closeLabel = "Close", onOpenAutoFocus, onCloseAutoFocus, ...props },
    ref,
  ) => {
    const boxRef = useCenterDialogMorph(ref);
    const openerFocus = useDialogOpenerFocus(onOpenAutoFocus, onCloseAutoFocus);
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={boxRef}
          className={cn(dialogChrome.surface, "max-w-lg", className)}
          data-dialog-surface=""
          data-lenis-prevent=""
          {...props}
          onOpenAutoFocus={openerFocus.onOpenAutoFocus}
          onCloseAutoFocus={openerFocus.onCloseAutoFocus}
        >
          {children}
          <DialogPrimitive.Close asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              className="absolute right-2 top-2 size-8 pointer-coarse:size-11"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
CenterDialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * Left-edge modal navigation frame using the same Radix dialog stack as centered
 * forms. Owns the scrim, close control, focus trap, nested Escape arbitration,
 * scroll locking and opener restoration without scrolling the workspace.
 * Labels and navigation content belong to the caller; shared CSS retains both
 * panel and scrim through their 300ms exit before Radix unmounts the portal.
 */
export function NavigationDialogContent({
  children,
  title,
  closeLabel,
  id,
}: {
  children: React.ReactNode;
  title: string;
  closeLabel: string;
  id?: string;
}): React.ReactElement {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPortal>
      <DialogPrimitive.Overlay
        data-navigation-scrim=""
        className="fixed inset-0 z-50 bg-overlay/60 lg:hidden"
      />
      <DialogPrimitive.Content
        ref={contentRef}
        id={id}
        aria-describedby={undefined}
        data-navigation-panel=""
        data-lenis-prevent=""
        className="fixed inset-y-0 left-0 z-50 flex w-80 max-w-full flex-col overflow-hidden border-r border-line bg-canvas pt-(--safe-area-top) pb-(--safe-area-bottom) shadow-overlay outline-none lg:hidden"
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          openerRef.current = active instanceof HTMLElement ? active : null;
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = openerRef.current;
          openerRef.current = null;
          if (opener?.isConnected) opener.focus({ preventScroll: true });
        }}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <DialogPrimitive.Close asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-[calc(var(--safe-area-top)+0.5rem)] z-10 size-8"
            aria-label={closeLabel}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </DialogPrimitive.Close>
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/**
 * Header section of a dialog containing title and description elements with
 * left alignment at every width, matching `CenterAlertDialogHeader`.
 *
 * @param className - Class overrides for header alignment and spacing.
 * @param props - HTML div attributes forwarded to the header container.
 */
export const CenterDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.header, className)} {...props} />
);
CenterDialogHeader.displayName = "CenterDialogHeader";

/**
 * Footer action container positioned at the bottom of the dialog.
 *
 * Stacks action buttons vertically on mobile screens and aligns them to the right on desktop views.
 *
 * @param className - Class overrides for action alignment.
 * @param props - HTML div attributes forwarded to the footer container.
 */
export const CenterDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.footer, className)} {...props} />
);
CenterDialogFooter.displayName = "CenterDialogFooter";

/**
 * Accessible title heading for the dialog.
 *
 * Automatically announces itself as the modal's primary label for screen readers via aria-labelledby.
 *
 * @param className - Class overrides for typography or text colors.
 * @param props - Radix Dialog Title properties.
 * @param ref - Forwarded DOM reference to the title heading element.
 */
export const CenterDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn(dialogChrome.title, className)} {...props} />
));
CenterDialogTitle.displayName = DialogPrimitive.Title.displayName;

/**
 * Accessible description paragraph providing secondary explanatory text for the dialog modal.
 *
 * Linked to the dialog container via aria-describedby for accessibility.
 *
 * @param className - Class overrides for description text styles.
 * @param props - Radix Dialog Description properties.
 * @param ref - Forwarded DOM reference to the description element.
 */
export const CenterDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(dialogChrome.description, className)}
    {...props}
  />
));
CenterDialogDescription.displayName = DialogPrimitive.Description.displayName;
