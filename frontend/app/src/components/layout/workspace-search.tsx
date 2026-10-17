import { useRef, useState } from "react";
import { ArrowRight, LayoutGrid, Search } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogTitle,
} from "@meltiply/ui/center-dialog";
import { WORKSPACE_NAV_ITEMS, type WorkspaceView } from "@/components/primitives/sidebar-nav";
import { useWorkspace } from "@/context/workspace.context";
import { useI18n } from "@/lib/i18n";

/**
 * Keyboard-accessible jump palette over real destinations and loaded Brand
 * Profiles. It never claims to search unloaded Posts: collection search remains
 * in each route's toolbar. Choosing a profile updates the existing scope owner.
 * Radix handles autofocus, Tab, Escape, and focus restoration on dismissal.
 */
export function WorkspaceSearch({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
}) {
  const { brandProfiles, setSelectedBrandProfileId } = useWorkspace();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const destinations = WORKSPACE_NAV_ITEMS.filter((item) =>
    t(item.label).toLocaleLowerCase().includes(normalized),
  );
  const profiles = brandProfiles.filter((profile) =>
    profile.name.toLocaleLowerCase().includes(normalized),
  );
  return (
    <CenterDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <CenterDialogContent
        className="max-w-xl overflow-hidden p-0"
        aria-describedby="workspace-search-description"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <CenterDialogTitle className="sr-only">{t("Search and jump to")}</CenterDialogTitle>
        <CenterDialogDescription id="workspace-search-description" className="sr-only">
          {t(
            "Find workspace pages and Brand Profiles. Search posts and channels from their page toolbar.",
          )}
        </CenterDialogDescription>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3 pr-10">
          <Search className="size-4 shrink-0 text-ink-3" />
          <Input
            aria-label={t("Search pages and Brand Profiles")}
            placeholder={t("Search pages and Brand Profiles…")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[55dvh] overflow-y-auto p-2" data-lenis-prevent>
          {destinations.length > 0 && (
            <section aria-label={t("Workspace")}>
              <h2 className="px-2 pb-1 pt-2 text-micro font-medium text-ink-3">{t("Workspace")}</h2>
              {destinations.map((item) => {
                const Icon = item.icon;
                return (
                  <Button
                    key={item.id}
                    variant="ghost"
                    className="h-10 w-full justify-start text-ui"
                    onClick={() => {
                      onNavigate(item.id);
                      onOpenChange(false);
                      setQuery("");
                    }}
                  >
                    <Icon className="size-4" />
                    {t(item.label)}
                    <ArrowRight className="ml-auto size-3.5 text-ink-3" />
                  </Button>
                );
              })}
            </section>
          )}
          {profiles.length > 0 && (
            <section aria-label={t("Brand Profiles")}>
              <h2 className="px-2 pb-1 pt-3 text-micro font-medium text-ink-3">
                {t("Brand Profiles")}
              </h2>
              {profiles.map((profile) => (
                <Button
                  key={profile.id}
                  variant="ghost"
                  className="h-10 w-full justify-start text-ui"
                  onClick={() => {
                    setSelectedBrandProfileId(profile.id);
                    onOpenChange(false);
                    setQuery("");
                  }}
                >
                  <LayoutGrid className="size-4" />
                  <span className="truncate">{profile.name}</span>
                </Button>
              ))}
            </section>
          )}
          {destinations.length === 0 && profiles.length === 0 && (
            <p role="status" className="px-3 py-10 text-center text-ui text-ink-2">
              {t("No matching pages or Brand Profiles.")}
            </p>
          )}
        </div>
        <p className="border-t border-line bg-inset px-4 py-2 text-micro text-ink-3">
          {t("Tab to move · Enter to open · Esc to close")}
        </p>
      </CenterDialogContent>
    </CenterDialog>
  );
}
