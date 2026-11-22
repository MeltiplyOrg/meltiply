import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Eye,
  LogOut,
  Languages,
  Monitor,
  Moon,
  Palette,
  Send,
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
import { ReportingSettings } from "@/components/settings/reporting-settings";
import { PublishingPreferencesSection } from "@/components/settings/publishing-preferences-section";
import SettingsPage from "@/app/(dashboard)/settings/page";

const SECTION_IDS = [
  "appearance",
  "language",
  "publishing",
  "account",
  "privacy",
  "security",
] as const;
type SettingsSection = (typeof SECTION_IDS)[number] | "administration";
const LANGUAGE_CODES = supportedLanguages.map(({ code }) => code);

const SECTION_GROUPS = [
  { id: "general", label: "General", sections: ["appearance", "language", "publishing"] },
  { id: "account", label: "Account", sections: ["account", "privacy", "security"] },
  { id: "workspace", label: "Workspace", sections: ["administration"] },
] as const satisfies readonly {
  id: string;
  label: string;
  sections: readonly SettingsSection[];
}[];

function PreviewLines() {
  return (
    <>
      <span className="h-1 rounded-sm bg-line-strong" />
      <span className="h-1 w-[70%] rounded-sm bg-accent" />
      <span className="h-1 rounded-sm bg-line-strong" />
    </>
  );
}

export default function WorkspaceSettings() {
  const { requestedTheme, setTheme } = useTheme();
  const { user, workspaceName, canManageSettings } = useWorkspace();
  const { t, language, setLanguage } = useI18n();
  const sections = useMemo<
    Record<
      SettingsSection,
      { label: string; navLabel: string; description: string; icon: typeof Palette }
    >
  >(
    () => ({
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
      publishing: {
        label: t("Publishing"),
        navLabel: t("Publishing"),
        description: t(
          "Choose the publishing timezone, reusable signatures, and notification choices.",
        ),
        icon: Send,
      },
      account: {
        label: t("Account and workspace"),
        navLabel: t("Account"),
        description: t("Your installation identity. These details are read-only."),
        icon: UserRound,
      },
      privacy: {
        label: t("Privacy"),
        navLabel: t("Privacy"),
        description: t(
          "Review what this installation shares with the Meltiply maintainer and who decides it.",
        ),
        icon: Eye,
      },
      security: {
        label: t("Account security"),
        navLabel: t("Security"),
        description: t(
          "Change your password, set up an authenticator, or replace recovery codes. Security changes require your current password.",
        ),
        icon: ShieldCheck,
      },
    }),
    [t],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get("section");
  const visibleGroups = SECTION_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter(
      (id) => canManageSettings || (id !== "publishing" && id !== "administration"),
    ),
  })).filter((group) => group.sections.length > 0);
  const sectionIds: readonly SettingsSection[] = visibleGroups.flatMap((group) => group.sections);
  const section = sectionIds.find((id) => id === requestedSection) ?? "appearance";
  const current = sections[section];
  const handleSignOut = useWorkspaceSignOut();
  const navRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

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

  useLayoutEffect(() => {
    centerActiveSection();
  }, [canManageSettings, centerActiveSection, section, language]);

  useEffect(() => {
    window.addEventListener("resize", centerActiveSection);
    return () => window.removeEventListener("resize", centerActiveSection);
  }, [centerActiveSection]);

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
  }, [canManageSettings, centerActiveSection, section, language]);

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
        <SidebarGlideHighlight containerRef={navRef} snapThreshold={12} />
        <span className="hidden px-2 pb-2 text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3 md:block">
          {t("Settings")}
        </span>
        {visibleGroups.map((group, groupIndex) => (
          <div
            key={group.id}
            role="group"
            aria-label={t(group.label)}
            className="contents md:flex md:flex-col md:gap-1"
          >
            {groupIndex > 0 && (
              <span
                aria-hidden="true"
                className="mx-1 my-1 h-5 w-px shrink-0 self-center bg-line md:hidden"
              />
            )}
            <span className="hidden px-2 pb-1 pt-2 text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3 md:block">
              {t(group.label)}
            </span>
            {group.sections.map((id) => {
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
          </div>
        ))}
      </nav>
      <div
        ref={contentRef}
        className={cn(
          "min-h-0 min-w-0 px-4 pb-20 pt-4 sm:px-6 sm:pt-6",
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
          {section === "privacy" && <ReportingSettings />}
          {section === "publishing" && <PublishingPreferencesSection />}
          {section === "administration" && <SettingsPage embedded />}
        </div>
      </div>
    </div>
  );
}
