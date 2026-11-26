import type { SessionClaims } from "@meltiply/auth";
import type { WorkspaceRole } from "@meltiply/domain";

export interface ResolvedActor {
  authUserId: string;
  claims: SessionClaims;
  displayName: string | null;
  email: string;
  isInstallationOwner: boolean;
  role: WorkspaceRole;
  userId: string;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
}
