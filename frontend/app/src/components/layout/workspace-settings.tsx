import {
  LogOut,
  Languages,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react";
import { useSearchParams } from "react-router";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { cn } from "@meltiply/ui/utils";
import { toast } from "@meltiply/ui/toast";
import { useWorkspace } from "@/context/workspace.context";
import { useTheme } from "@/lib/theme";
import { supportedLanguages, useI18n } from "@/lib/i18n";
import { AccountSecurity } from "@/components/auth/account-security";

const SECTION_IDS = ["appearance", "language", "account", "security"] as const;
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
 */
export default function WorkspaceSettings() {
  const { requestedTheme, setTheme } = useTheme();
  const { user, workspaceName, logout } = useWorkspace();
  const { t, language, setLanguage } = useI18n();
  const sections = {
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
  const section = SECTION_IDS.find((id) => id === requestedSection) ?? "appearance";
  const current = sections[section];
  /** Reports a failed server sign-out instead of discarding session errors. */
  const handleSignOut = async () => {
    try {
      await logout();
    } catch {
      toast(t("Could not sign out"), {
        description: t("Try again to end your session."),
        variant: "error",
      });
    }
  };
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-surface md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1">
      <nav
        aria-label={t("Settings sections")}
        className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-3 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:px-2.5 md:py-5"
      >
        <span className="hidden px-2 pb-2 text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3 md:block">
          {t("Settings")}
        </span>
        {SECTION_IDS.map((id) => {
          const Icon = sections[id].icon;
          return (
            <Button
              key={id}
              variant={section === id ? "secondary" : "ghost"}
              className="h-8 shrink-0 justify-start px-2 text-(length:--font-size-control) font-normal"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSearchParams({ section: id })}
            >
              <Icon className="size-3.5" />
              {sections[id].navLabel}
            </Button>
          );
        })}
      </nav>
      <div className="min-h-0 min-w-0 overflow-y-auto px-4 pb-20 pt-6 sm:px-10 sm:pt-8">
        <div className="w-full max-w-2xl">
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
        </div>
      </div>
    </div>
  );
}
