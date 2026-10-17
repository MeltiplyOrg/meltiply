import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "@meltiply/ui/utils";
import { buttonVariants } from "./button";
import { useCenterDialogMorph } from "./center-dialog-motion";

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
    className={cn(
      "fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
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
 */
export const CenterAlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const boxRef = useCenterDialogMorph(ref);
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        ref={boxRef}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-full max-w-md content-start -translate-x-1/2 -translate-y-1/2 gap-4 overflow-x-clip rounded-window border border-line bg-surface p-6 shadow-overlay dialog-bottom-popup",
          className,
        )}
        data-dialog-surface=""
        {...props}
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
  <div className={cn("flex flex-col gap-1.5 text-left", className)} {...props} />
);

/**
 * Horizontal action row anchoring the cancel/confirm buttons at the dialog foot.
 */
export const CenterAlertDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
    {...props}
  />
);

/**
 * Accessible dialog heading; Radix links it as the content's label.
 */
export const CenterAlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold text-ink", className)}
    {...props}
  />
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
    className={cn("text-[13px] leading-relaxed text-ink-2", className)}
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
