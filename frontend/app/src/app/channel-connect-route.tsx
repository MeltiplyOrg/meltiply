import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { AppProviders } from "@/app/providers";
import { ChannelAssignment } from "@/components/channels/channel-assignment";
import { WorkspaceProvider } from "@/context/workspace.context";
import { useSearchParams } from "@/lib/navigation";

function ChannelConnectSurface(): React.ReactElement | null {
  const searchParams = useSearchParams();
  const selectionId = searchParams.get("selection_id");
  const provider = searchParams.get("provider");
  const navigate = useNavigate();
  const finished = useRef(false);

  useEffect(() => {
    if (!selectionId) navigate("/channels", { replace: true });
  }, [selectionId, navigate]);

  const finish = useCallback(
    (connected: boolean) => {
      if (finished.current) return;
      finished.current = true;
      const outcome = connected
        ? `/channels?oauth=connected&provider=${encodeURIComponent(provider ?? "")}`
        : "/channels";
      navigate(outcome, { replace: true });
    },
    [navigate, provider],
  );

  const handleClose = useCallback(() => finish(false), [finish]);
  const handleSuccess = useCallback(() => finish(true), [finish]);

  return selectionId ? (
    <ChannelAssignment selectionId={selectionId} onClose={handleClose} onSuccess={handleSuccess} />
  ) : null;
}

export default function ChannelConnectRoute(): React.ReactElement {
  return (
    <AppProviders>
      <WorkspaceProvider>
        <ChannelConnectSurface />
      </WorkspaceProvider>
    </AppProviders>
  );
}
