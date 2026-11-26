import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "@meltiply/ui/utils";
import { buttonVariants } from "./button";
import { useCenterDialogMorph } from "./center-dialog-motion";
import { useDialogOpenerFocus } from "./dialog-opener-focus";
import { dialogChrome } from "./dialog-chrome";

export const CenterAlertDialog = AlertDialogPrimitive.Root;
const AlertDialogPortal = AlertDialogPrimitive.Portal;

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

export const CenterAlertDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.header, className)} {...props} />
);

export const CenterAlertDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.footer, className)} {...props} />
);

export const CenterAlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn(dialogChrome.title, className)} {...props} />
));
CenterAlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

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
