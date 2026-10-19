import { useCallback } from "react";
import { toast } from "@meltiply/ui/toast";
import { useWorkspace } from "@/context/workspace.context";
import { useI18n } from "@/lib/i18n";

/** Ends the real workspace session; failed server sign-out remains visible from every entrypoint. */
export function useWorkspaceSignOut(): () => Promise<void> {
  const { logout } = useWorkspace();
  const { t } = useI18n();
  return useCallback(async () => {
    try {
      await logout();
    } catch {
      toast(t("Could not sign out"), {
        description: t("Try again to end your session."),
        variant: "error",
      });
    }
  }, [logout, t]);
}
