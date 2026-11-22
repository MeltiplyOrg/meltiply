import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useOnboarding } from "@/lib/queries";
import { WorkspaceLoadingSkeleton } from "@/components/layout/workspace-loading-skeleton";

import { OnboardingWizard } from "./onboarding-wizard";

export function OnboardingGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isInstallationOwner } = useWorkspace();
  const scope = useSessionScope();
  const onboarding = useOnboarding(scope, isInstallationOwner);

  if (!isInstallationOwner) return <>{children}</>;
  if (onboarding.isPending) return <WorkspaceLoadingSkeleton />;
  if (onboarding.data?.status === "in_progress")
    return <OnboardingWizard progress={onboarding.data} />;
  return <>{children}</>;
}
