import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { useCenterDialogMorph } from "./center-dialog-motion";
import { useDialogOpenerFocus } from "./dialog-opener-focus";
import { Button } from "./button";
import { dialogChrome } from "./dialog-chrome";

export const CenterDialog = DialogPrimitive.Root;

export const CenterDialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

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
  closeLabel?: string;
}

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

export const CenterDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.header, className)} {...props} />
);
CenterDialogHeader.displayName = "CenterDialogHeader";

export const CenterDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(dialogChrome.footer, className)} {...props} />
);
CenterDialogFooter.displayName = "CenterDialogFooter";

export const CenterDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn(dialogChrome.title, className)} {...props} />
));
CenterDialogTitle.displayName = DialogPrimitive.Title.displayName;

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
