import React, { useState } from "react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Alert } from "@meltiply/ui/alert";
import { useMeltiplyAuth } from "./auth-provider";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/lib/i18n";

/**
 * Inline account-security controls, always password-reauthenticated.
 * Secrets remain in component state and are discarded on leaving this section.
 * TOTP stays pending until confirmed or explicitly cancelled. Security changes
 * require a fresh sign-in; regenerated backup codes replace the previous set.
 */
export function AccountSecurity(): React.ReactElement {
  const { user, signOut } = useMeltiplyAuth();
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{ totpURI?: string; backupCodes?: string[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (
    action: "enable" | "disable" | "generate-backup-codes" | "confirm" | "password" | "cancel",
  ) => {
    if (!password) {
      setError(t("Enter your current password to continue."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (action === "confirm") {
        await authClient.verifySecondFactor(code.trim());
        await signOut();
      } else if (action === "password") {
        await authClient.changePassword({ currentPassword: password, newPassword });
        await signOut();
      } else {
        const result = await authClient.manageTwoFactor(
          action === "cancel" ? "disable" : action,
          password,
        );
        if (action === "disable" || action === "cancel") {
          setEnrollment(null);
          await signOut();
        } else setEnrollment(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not update account security."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t("Account security")} className="w-full max-w-xl space-y-5">
      <p className="text-sm text-ink-2">
        {t(
          "Protect the only account for this installation. Changes to your password or authenticator sign out previous sessions.",
        )}
      </p>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="security-password" className="text-sm font-medium text-ink">
            {t("Current password")}
          </label>
          <Input
            id="security-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </div>
        {enrollment ? (
          <div className="space-y-4">
            {enrollment.totpURI && (
              <div className="space-y-2">
                <label htmlFor="authenticator-uri" className="text-sm font-medium text-ink">
                  {t("Authenticator setup key")}
                </label>
                <Input
                  id="authenticator-uri"
                  readOnly
                  value={new URL(enrollment.totpURI).searchParams.get("secret") ?? ""}
                />
                <p className="text-xs text-ink-2">
                  {t(
                    "Add a time-based account named Meltiply in your authenticator using this key. Keep it secret.",
                  )}
                </p>
              </div>
            )}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink">{t("Save your backup codes")}</h3>
              <p className="text-xs text-ink-2">
                {t(
                  "Store these somewhere safe before continuing. Each code works once. New codes invalidate the previous set.",
                )}
              </p>
              <pre className="select-text rounded-control border border-line bg-inset p-3 text-sm text-ink">
                {enrollment.backupCodes?.join("\n")}
              </pre>
            </div>
            {enrollment.totpURI ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act("confirm");
                }}
                className="space-y-3"
              >
                <label htmlFor="enrollment-code" className="text-sm font-medium text-ink">
                  {t("Authenticator code")}
                </label>
                <Input
                  id="enrollment-code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={busy}
                />
                <Button type="submit" disabled={busy}>
                  {t("I saved my codes — verify")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    void act("cancel");
                  }}
                >
                  {t("Cancel enrollment")}
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                disabled={busy}
                onClick={async () => {
                  try {
                    await signOut();
                  } catch {
                    setError(
                      t("Could not confirm server sign-out. Sign in again to check your sessions."),
                    );
                  }
                }}
              >
                {t("I saved my codes")}
              </Button>
            )}
          </div>
        ) : (
          <>
            <section className="space-y-3 border-t border-line pt-4">
              <h3 className="text-sm font-medium text-ink">{t("Two-factor authentication")}</h3>
              <p className="text-sm text-ink-2">
                {user?.twoFactorEnabled
                  ? t(
                      "An authenticator code is required at sign-in. Use a backup code if you lose your authenticator.",
                    )
                  : t(
                      "Add an authenticator app and save recovery codes before enabling this extra sign-in check.",
                    )}
              </p>
              {user?.twoFactorEnabled ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      void act("generate-backup-codes");
                    }}
                  >
                    {t("Replace backup codes")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      void act("disable");
                    }}
                  >
                    {t("Disable two-factor")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void act("enable");
                  }}
                >
                  {t("Set up authenticator")}
                </Button>
              )}
            </section>
            <form
              className="space-y-3 border-t border-line pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void act("password");
              }}
            >
              <label htmlFor="security-new-password" className="text-sm font-medium text-ink">
                {t("New password")}
              </label>
              <Input
                id="security-new-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={busy}
              />
              <Button type="submit" disabled={busy}>
                {t("Change password and sign out")}
              </Button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
