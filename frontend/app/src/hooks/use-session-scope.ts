import { useMemo } from "react";

import { useMeltiplyAuth } from "@/components/auth/auth-provider";
import type { SessionScope } from "@/lib/effect";

export function useSessionScope(): SessionScope {
  const { isSignedIn, workspaceId, brandProfileId } = useMeltiplyAuth();
  return useMemo(
    () => ({ isSignedIn, workspaceId, brandProfileId }),
    [isSignedIn, workspaceId, brandProfileId],
  );
}
