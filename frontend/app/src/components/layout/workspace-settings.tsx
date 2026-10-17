import { LogOut, Moon, Palette, Settings, ShieldCheck, Sun, UserRound } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogTrigger,
} from "@meltiply/ui/center-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@meltiply/ui/tabs";
import { cn } from "@meltiply/ui/utils";
import { toast } from "@meltiply/ui/toast";
import { useWorkspace } from "@/context/workspace.context";
import { useTheme } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";
import { AccountSecurity } from "@/components/auth/account-security";

/**
 * Adapts Gr8r's settings navigation to supported Meltiply preferences and account
 * actions. Identity remains read-only; theme uses the consent-aware provider;
 * security delegates to the existing password-reauthenticated flow. No billing,
 * team administration, or unsupported preference controls are advertised.
 */
export function WorkspaceSettings({ compact = false }: { compact?: boolean }) {
  const { requestedTheme, setTheme } = useTheme();
  const { user, workspaceName, logout } = useWorkspace();
  const { t } = useI18n();
  /** Reports a failed server sign-out instead of silently discarding session errors. */
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
    <CenterDialog>
      <CenterDialogTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon" : "default"}
          aria-label={t("Settings")}
          title={t("Settings")}
          className={cn("workspace-settings-trigger", !compact && "w-full justify-start")}
        >
          <Settings className="size-4" aria-hidden="true" />
          {!compact && t("Settings")}
        </Button>
      </CenterDialogTrigger>
      <CenterDialogContent
        className="w-[calc(100vw-24px)] max-w-3xl overflow-hidden p-0"
        aria-describedby="workspace-settings-description"
      >
        <CenterDialogHeader className="border-b border-line px-5 py-4">
          <CenterDialogTitle>{t("Settings")}</CenterDialogTitle>
          <CenterDialogDescription id="workspace-settings-description">
            {t("Your workspace, appearance, and account security.")}
          </CenterDialogDescription>
        </CenterDialogHeader>
        <Tabs defaultValue="appearance" className="workspace-settings">
          <TabsList aria-label={t("Settings sections")} className="workspace-settings-nav">
            <TabsTrigger value="appearance">
              <Palette className="size-4" />
              {t("Appearance")}
            </TabsTrigger>
            <TabsTrigger value="account">
              <UserRound className="size-4" />
              {t("Account")}
            </TabsTrigger>
            <TabsTrigger value="security">
              <ShieldCheck className="size-4" />
              {t("Security")}
            </TabsTrigger>
          </TabsList>
          <div className="min-w-0 overflow-y-auto p-5 sm:p-7" data-lenis-prevent>
            <TabsContent value="appearance" className="m-0 space-y-6">
              <div>
                <h2 className="text-base font-semibold">{t("Appearance")}</h2>
                <p className="mt-1 text-[13px] text-ink-2">
                  {t("Choose the palette for this device.")}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3" aria-label={t("Theme")}>
                {(["light", "dark"] as const).map((theme) => {
                  const Icon = theme === "light" ? Sun : Moon;
                  return (
                    <Button
                      key={theme}
                      variant="outline"
                      aria-pressed={requestedTheme === theme}
                      onClick={() => setTheme(theme)}
                      className={cn(
                        "h-auto flex-col items-stretch gap-3 p-3",
                        requestedTheme === theme && "border-accent ring-1 ring-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "theme-preview",
                          theme === "dark" ? "theme-preview-dark" : "theme-preview-light",
                        )}
                        aria-hidden="true"
                      >
                        <span className="theme-preview-sidebar">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="theme-preview-main">
                          <i />
                          <i />
                          <i />
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4" />
                        {t(theme === "light" ? "Light" : "Dark")}
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
            </TabsContent>
            <TabsContent value="account" className="m-0 space-y-5">
              <div>
                <h2 className="text-base font-semibold">{t("Account and workspace")}</h2>
                <p className="mt-1 text-[13px] text-ink-2">
                  {t("Your installation identity. These details are read-only.")}
                </p>
              </div>
              <dl className="settings-details">
                <div>
                  <dt>{t("Name")}</dt>
                  <dd>{user?.name ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("Email")}</dt>
                  <dd>{user?.email ?? "—"}</dd>
                </div>
                <div>
                  <dt>{t("Workspace")}</dt>
                  <dd>{workspaceName ?? "Meltiply"}</dd>
                </div>
              </dl>
              <Button
                variant="outline"
                onClick={() => {
                  void handleSignOut();
                }}
              >
                <LogOut className="size-4" />
                {t("Sign out")}
              </Button>
            </TabsContent>
            <TabsContent value="security" className="m-0 space-y-5">
              <div>
                <h2 className="text-base font-semibold">{t("Account security")}</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  {t(
                    "Change your password, set up an authenticator, or replace recovery codes. Security changes require your current password.",
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-control border border-line p-3">
                <AccountSecurity />
                <span className="text-[13px]">{t("Open account security")}</span>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </CenterDialogContent>
    </CenterDialog>
  );
}
