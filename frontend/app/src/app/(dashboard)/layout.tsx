import { Outlet } from "react-router";

import { NavigationShell } from "@/components/layout/navigation-shell";
import { resolveWorkspaceView, usePathname, useWorkspaceNavigate } from "@/lib/navigation";
import { WorkspaceProvider } from "@/context/workspace.context";
import { OnboardingGate } from "@/components/onboarding/onboarding-gate";
import { PublishingTimeZoneProvider } from "@/context/publishing-timezone.context";

import { AppProviders } from "../providers";

type DashboardLayoutProps = Readonly<{
  children?: React.ReactNode;
}>;

function WorkspaceShell({ children }: DashboardLayoutProps): React.ReactElement {
  const pathname = usePathname();
  const handleNavigate = useWorkspaceNavigate();
  const currentView = resolveWorkspaceView(pathname);

  return (
    <NavigationShell currentView={currentView} onNavigate={handleNavigate}>
      {children ?? <Outlet />}
    </NavigationShell>
  );
}

export default function DashboardLayout({ children }: DashboardLayoutProps): React.ReactElement {
  return (
    <AppProviders>
      <WorkspaceProvider>
        <OnboardingGate>
          <PublishingTimeZoneProvider>
            <WorkspaceShell>{children}</WorkspaceShell>
          </PublishingTimeZoneProvider>
        </OnboardingGate>
      </WorkspaceProvider>
    </AppProviders>
  );
}
