import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  LogOut,
  Languages,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { useSearchParams } from "react-router";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { SidebarGlideHighlight } from "@meltiply/ui/sidebar-glide-highlight";
import { cn } from "@meltiply/ui/utils";
import { useWorkspaceSignOut } from "@/hooks/use-workspace-sign-out";
import { useWorkspace } from "@/context/workspace.context";
import { useTheme } from "@/lib/theme";
import { supportedLanguages, useI18n } from "@/lib/i18n";
import { AccountSecurity } from "@/components/auth/account-security";
import SettingsPage from "@/app/(dashboard)/settings/page";

const SECTION_IDS = ["appearance", "language", "account", "security"] as const;
type SettingsSection = (typeof SECTION_IDS)[number] | "administration";
const LANGUAGE_CODES = supportedLanguages.map(({ code }) => code);

/** Decorative miniature lines shared by both halves of every theme preview; no palette values are copied. */
function PreviewLines() {
  return (
    <>
      <span className="h-1 rounded-sm bg-line-strong" />
      <span className="h-1 w-[70%] rounded-sm bg-accent" />
      <span className="h-1 rounded-sm bg-line-strong" />
    </>
  );
}

/**
 * Gr8r's full-height Settings composition, adapted only to supported preferences
 * and account operations. Section URLs are reloadable; language/theme delegate
 * to existing consent-aware providers. Identity is read-only and security keeps
 * password reauthentication. No demo billing, teams, or fake controls survive.
 *
 * The section rail marks its rows as `data-sidebar-item` targets so the shared
 * `SidebarGlideHighlight` pill owns the hover background here too, exactly as in
 * the workspace rail. The rail centers the reloadable route's active section on
 * mount, section or language change, and resize; changing sections also returns
 * the content pane to its top while a language change leaves its position alone.
 */
export default function WorkspaceSettings() {
  const { requestedTheme, setTheme } = useTheme();
  const { user, workspaceName, canManageSettings } = useWorkspace();
  const { t, language, setLanguage } = useI18n();
  const sections: Record<
    SettingsSection,
    { label: string; navLabel: string; description: string; icon: typeof Palette }
  > = {
    administration: {
      label: t("Administration"),
      navLabel: t("Administration"),
      description: t(
        "Manage who can access this installation, the shared workspace, and its audit trail.",
      ),
      icon: Users,
    },
    appearance: {
      label: t("Appearance"),
      navLabel: t("Appearance"),
      description: t("Choose the palette for this device."),
      icon: Palette,
    },
    language: {
      label: t("Language"),
      navLabel: t("Language"),
      description: t("Choose the language used throughout your workspace."),
      icon: Languages,
    },
    account: {
      label: t("Account and workspace"),
      navLabel: t("Account"),
      description: t("Your installation identity. These details are read-only."),
      icon: UserRound,
    },
    security: {
      label: t("Account security"),
      navLabel: t("Security"),
      description: t(
        "Change your password, set up an authenticator, or replace recovery codes. Security changes require your current password.",
      ),
      icon: ShieldCheck,
    },
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get("section");
  const sectionIds: readonly SettingsSection[] = canManageSettings
    ? ["administration", ...SECTION_IDS]
    : SECTION_IDS;
  const section = sectionIds.find((id) => id === requestedSection) ?? "appearance";
  const current = sections[section];
  const handleSignOut = useWorkspaceSignOut();
  const navRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  /**
   * Centers the active section button inside the horizontal Settings rail.
   *
   * Writes the rail's own `scrollLeft` rather than calling `scrollIntoView`, so
   * centering a tab can never move the vertically scrolling page. The offset is
   * clamped to the rail's scrollable range, and a rail that does not scroll
   * horizontally (the desktop vertical rail) is left untouched.
   */
  const centerActiveSection = useCallback(() => {
    const railElement = navRef.current;
    if (!railElement) return;
    const maxScrollLeft = railElement.scrollWidth - railElement.clientWidth;
    if (maxScrollLeft <= 0) return;
    const activeSection = railElement.querySelector<HTMLElement>('[aria-current="page"]');
    if (!activeSection) return;
    const centeredOffset =
      activeSection.offsetLeft + activeSection.offsetWidth / 2 - railElement.clientWidth / 2;
    railElement.scrollLeft = Math.min(Math.max(centeredOffset, 0), maxScrollLeft);
  }, []);

  // A reload or history entry mounts with its section already selected, so
  // center before paint. Label widths change with the language, and a resized
  // rail moves the scrollable range, so both re-run the same centering.
  useLayoutEffect(() => {
    centerActiveSection();
  }, [centerActiveSection, section, language]);

  useEffect(() => {
    window.addEventListener("resize", centerActiveSection);
    return () => window.removeEventListener("resize", centerActiveSection);
  }, [centerActiveSection]);

  // Self-hosted fonts widen the section labels after the first layout pass, and
  // the dialog/viewport can resize the rail without a window resize event. Every
  // section button is observed: a label change on any tab shifts the active tab's
  // position even when the rail box and the active label keep their own size.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const railElement = navRef.current;
    if (!railElement) return;
    const observer = new ResizeObserver(centerActiveSection);
    observer.observe(railElement);
    for (const sectionButton of railElement.querySelectorAll<HTMLElement>("[data-sidebar-item]")) {
      observer.observe(sectionButton);
    }
    return () => observer.disconnect();
  }, [centerActiveSection, section, language]);

  // `document.fonts` is absent in jsdom. `ready` can resolve before the request
  // that widens these labels, so the loading event is the late-growth trigger;
  // `ready` remains a cheap retry for browsers that only settle once.
  useEffect(() => {
    const fonts: FontFaceSet | undefined = document.fonts;
    if (!fonts) return;
    const canListen = typeof fonts.addEventListener === "function";
    if (canListen) fonts.addEventListener("loadingdone", centerActiveSection);
    let cancelled = false;
    void fonts.ready.then(() => {
      if (!cancelled) centerActiveSection();
    });
    return () => {
      cancelled = true;
      if (canListen) fonts.removeEventListener("loadingdone", centerActiveSection);
    };
  }, [centerActiveSection]);

  // Section changes open the new form at its own top; a language change keeps the
  // reader's position in the current form.
  const previousSectionRef = useRef(section);
  useLayoutEffect(() => {
    if (previousSectionRef.current === section) return;
    previousSectionRef.current = section;
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [section]);
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-surface md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1">
      <nav
        ref={navRef}
        aria-label={t("Settings sections")}
        className="relative flex gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-3 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:px-2.5 md:py-5"
      >
        {/* The section rail reuses the rail pill: a 12px snap radius crosses the
            4px row gap without lighting a row from the neighbouring content. */}
        <SidebarGlideHighlight containerRef={navRef} snapThreshold={12} />
        <span className="hidden px-2 pb-2 text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3 md:block">
          {t("Settings")}
        </span>
        {sectionIds.map((id) => {
          const Icon = sections[id].icon;
          const isCurrent = section === id;
          return (
            <Button
              key={id}
              variant={isCurrent ? "secondary" : "ghost"}
              data-sidebar-item=""
              className={cn(
                "relative z-10 h-8 shrink-0 justify-start px-2 text-(length:--font-size-control) font-normal",
                isCurrent ? "hover:bg-secondary" : "hover:bg-transparent",
              )}
              aria-current={isCurrent ? "page" : undefined}
              onClick={() => setSearchParams({ section: id })}
            >
              <Icon className="size-3.5" />
              {sections[id].navLabel}
            </Button>
          );
        })}
      </nav>
      <div
        ref={contentRef}
        className={cn(
          "min-h-0 min-w-0 px-4 pb-20 pt-5 sm:px-6 sm:pt-6",
          section === "administration" ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
        <div
          className={cn(
            "w-full",
            section === "administration"
              ? "mx-auto flex h-full min-h-0 max-w-300 flex-col"
              : "max-w-2xl",
          )}
        >
          <h1 className="text-(length:--text-title) font-semibold leading-tight tracking-page-title">
            {current.label}
          </h1>
          <p className="mb-6 mt-1 text-(length:--font-size-ui) text-ink-2">{current.description}</p>
          {section === "appearance" && (
            <section aria-label={t("Theme")} className="space-y-4">
              <h2 className="text-(length:--font-size-ui) font-semibold">{t("Theme")}</h2>
              <div className="flex flex-wrap gap-3">
                {(["light", "dark", "system"] as const).map((theme) => {
                  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
                  return (
                    <Button
                      key={theme}
                      variant="outline"
                      aria-pressed={requestedTheme === theme}
                      onClick={() => setTheme(theme)}
                      className={cn(
                        "h-auto w-48 max-w-full flex-col items-stretch gap-3 p-3",
                        requestedTheme === theme && "border-accent ring-1 ring-accent",
                      )}
                    >
                      <span
                        data-palette={theme === "system" ? undefined : theme}
                        className="grid h-22 grid-cols-[28%_1fr] overflow-hidden rounded-chip border border-line"
                        aria-hidden="true"
                      >
                        <span className="flex flex-col gap-2 bg-canvas px-2 py-3">
                          <PreviewLines />
                        </span>
                        <span className="flex flex-col gap-2 bg-page px-2 py-3">
                          <PreviewLines />
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4" />
                        {theme === "light"
                          ? t("Light")
                          : theme === "dark"
                            ? t("Dark")
                            : t("System")}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <p className="border-t border-line pt-4 text-xs leading-relaxed text-ink-2">
                {t(
                  "Theme changes apply immediately. Saving your preference across visits requires functional cookie consent.",
                )}
              </p>
            </section>
          )}
          {section === "language" && (
            <section className="space-y-4">
              <h2 className="text-(length:--font-size-ui) font-semibold">
                {t("Interface language")}
              </h2>
              <SegmentedControl
                options={LANGUAGE_CODES}
                value={language}
                onChange={setLanguage}
                label={t("Language")}
                className="max-w-full overflow-x-auto"
                renderOption={(code) =>
                  supportedLanguages.find((option) => option.code === code)?.label ?? code
                }
              />
              <p className="border-t border-line pt-4 text-xs text-ink-2">
                {t(
                  "Language changes apply immediately. Saving your preference across visits requires functional cookie consent.",
                )}
              </p>
            </section>
          )}
          {section === "account" && (
            <section className="space-y-5">
              <dl>
                {[
                  { label: t("Name"), value: user?.name },
                  { label: t("Email"), value: user?.email },
                  { label: t("Workspace"), value: workspaceName ?? "Meltiply" },
                ].map((field) => (
                  <div
                    key={field.label}
                    className="grid grid-cols-[96px_minmax(0,1fr)] gap-4 border-b border-line py-3.5 text-(length:--font-size-control)"
                  >
                    <dt className="text-ink-2">{field.label}</dt>
                    <dd className="wrap-anywhere">{field.value ?? "—"}</dd>
                  </div>
                ))}
              </dl>
              <Button variant="outline" onClick={() => void handleSignOut()}>
                <LogOut className="size-4" />
                {t("Sign out")}
              </Button>
            </section>
          )}
          {section === "security" && <AccountSecurity />}
          {section === "administration" && <SettingsPage embedded />}
        </div>
      </div>
    </div>
  );
}
