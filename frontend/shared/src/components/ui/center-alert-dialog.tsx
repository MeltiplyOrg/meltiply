import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "@meltiply/ui/utils";
import { buttonVariants } from "./button";
import { useCenterDialogMorph } from "./center-dialog-motion";
import { useDialogOpenerFocus } from "./dialog-opener-focus";
import { dialogChrome } from "./dialog-chrome";

/**
 * Confirmation variant of the centered dialog type, for explicit
 * destructive/irreversible acknowledgement. Same placement and motion as
 * `CenterDialog`, including the morph a confirmation takes when it opens from or
 * hands back to a centered dialog behind it, but outside clicks cannot dismiss
 * it. Alias for Radix AlertDialog Root.
 */
export const CenterAlertDialog = AlertDialogPrimitive.Root;
const AlertDialogPortal = AlertDialogPrimitive.Portal;

/**
 * Dimmed backdrop behind an active confirmation dialog.
 */
const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    data-dialog-backdrop=""
    className={cn(dialogChrome.backdrop, className)}
    {...props}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

/**
 * Centered confirmation modal. It shares `CenterDialog`'s morph: opening from a
 * centered dialog, or handing its box back to one, resizes the surface in place
 * with the content sliding sideways, and a confirmation opened on its own pops
 * up and pops out from the bottom edge. Traps focus and blocks outside dismissal
 * so destructive actions require an explicit answer.
 * Dynamic-viewport bounds and native scrolling keep both answers reachable on
 * phones and short landscape screens without weakening confirmation semantics.
 *
 * Shares `dialogChrome` with `CenterDialogContent`; only the narrower width and
 * the AlertDialog's non-dismissible semantics differ. There is no corner close
 * button: answering requires Cancel or the destructive action. Closing restores
 * focus to the control that opened the confirmation, not to a Radix trigger.
 */
export const CenterAlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  const boxRef = useCenterDialogMorph(ref);
  const openerFocus = useDialogOpenerFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={boxRef}
        className={cn(dialogChrome.surface, "max-w-md", className)}
        data-lenis-prevent=""
        data-dialog-surface=""
        {...props}
        onOpenAutoFocus={openerFocus.onOpenAutoFocus}
        onCloseAutoFocus={openerFocus.onCloseAutoFocus}
      >
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPortal>
  );
});
CenterAlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

/**
 * Vertical layout wrapper for the dialog's title and description block.
 */
export const CenterAlertDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.header, className)} {...props} />
);

/**
 * Horizontal action row anchoring the cancel/confirm buttons at the dialog foot.
 */
export const CenterAlertDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.footer, className)} {...props} />
);

/**
 * Accessible dialog heading; Radix links it as the content's label.
 */
export const CenterAlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn(dialogChrome.title, className)} {...props} />
));
CenterAlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

/**
 * Supporting description text; Radix links it as the content's accessible description.
 */
export const CenterAlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn(dialogChrome.description, className)}
    {...props}
  />
));
CenterAlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

/**
 * Confirmation button; defaults to the destructive button treatment.
 */
export const CenterAlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={cn(buttonVariants({ variant: "destructive" }), className)}
    {...props}
  />
));
CenterAlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

/**
 * Dismissal button; defaults to the outline button treatment.
 */
export const CenterAlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(buttonVariants({ variant: "outline" }), className)}
    {...props}
  />
));
CenterAlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;
