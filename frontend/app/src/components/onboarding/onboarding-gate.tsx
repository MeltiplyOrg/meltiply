import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useOnboarding } from "@/lib/queries";
import { WorkspaceLoadingSkeleton } from "@/components/layout/workspace-loading-skeleton";

import { OnboardingWizard } from "./onboarding-wizard";

/**
 * Resumes unfinished first-run setup for the current Installation Owner only.
 *
 * The decision comes entirely from the authenticated onboarding contract, so an
 * upgraded installation (`not_applicable`) and an invited member (refused
 * outright) never enter the wizard, and no client guess reopens registration or
 * forces an account-creation journey. A read failure renders the normal
 * workspace instead of blocking access: the journey is optional, and it resumes
 * on the next load once the read succeeds.
 *
 * @param props.children The authenticated workspace layout.
 * @returns The wizard while onboarding is in progress, otherwise the children.
 */
export function OnboardingGate({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { isInstallationOwner } = useWorkspace();
  const scope = useSessionScope();
  const onboarding = useOnboarding(scope, isInstallationOwner);

  if (!isInstallationOwner) return <>{children}</>;
  if (onboarding.isPending) return <WorkspaceLoadingSkeleton />;
  if (onboarding.data?.status === "in_progress") return <OnboardingWizard progress={onboarding.data} />;
  return <>{children}</>;
}
